import type { Candidate, CacheEntry, InspectableCacheStore } from "./types/CacheStore.ts";
import type { RedisExecutor } from "./types/RedisExecutor.ts";

/**
 * Redis 实现，走 Redis 8 内置的 **Vector Set**（`VADD` / `VSIM`），不是 RediSearch。
 * 判定逻辑一行都不用改 —— `SemanticCache` 只认 `CacheStore` 接口。
 *
 * 选 vectorset 而不是 `FT.*` 的原因很实际：它在 Redis 8 的核心里，`MODULE LIST`
 * 直接就有，不用额外装 Redis Stack。代价见下面第 2 条。
 *
 * 四处不能省的约束：
 *
 * 1. **必须 `NOQUANT`**。`VADD` 默认按 Q8 量化，int8 的分辨率比 pgvector 的 float4
 *    粗两个数量级，会把召回顺序摇出可见的差别。加上 `NOQUANT` 之后 `VINFO` 报
 *    `quant-type f32`，往返偏差实测约 4e-9，和 pgvector 同级。
 * 2. **只有 `searchNearest` 是库给的，另外八个方法要自己建二级索引。** 向量集是
 *    「一个 key 装一组 (元素, 向量, 属性)」，不是文档库：没有按哈希查、没有按
 *    资料 id 反查、没有 scope 计数。所以这里额外维护 5 个结构（见 keys），
 *    并且**写路径全部走 Lua**——多结构写一半崩掉留下的孤儿索引，是这条路上
 *    唯一会静默给出错答案的失效方式，MULTI 在连接池下还挡不住它。
 * 3. **过期不能用 Redis 原生 TTL。** 接口要求过期条目「读路径看不见，但 `all()`
 *    要看得见」，而 `PEXPIREAT` 是真删，`all()` 就再也看不见了；何况 `now` 是注入
 *    的，假时钟根本驱动不了原生 TTL。所以 `expires_at` 落成参与 `FILTER` 的普通
 *    数值属性，清理走显式的 `purgeExpired()`。
 * 4. **`VSIM` 的分数不是余弦，是 `(1 + 余弦) / 2`**（实测：正交向量给 0.5，
 *    夹角余弦 −0.67466 给 0.16268）。取 `2 * score - 1` 才等于 `VectorMath.cosine`，
 *    内存实现与真库的召回排序因此一致。
 *
 * **两处真实精度差异，别当成 bug 去修**：向量按 float32 存（同 pgvector）；
 * 相似度经 Lua 的 `tostring` 回来，是 14 位有效数字。两者都远小于任何标定出来的
 * 阈值间距，但**恰好压在阈值上的样本可能倒向另一边**——阈值在哪个后端标的，
 * 就在哪个后端验。lab/scripts/storeConformance.ts 把这条写成了判据。
 *
 * **单实例假设**：Lua 脚本里按 id 现拼二级索引的 key，没有全部声明进 KEYS，
 * 在 Redis Cluster 上会被拒。要上 Cluster 得给整个命名空间套 hash tag。
 */
export interface RedisVectorSetCacheStoreOptions {
	readonly redis: RedisExecutor;
	/**
	 * 两个向量的维度。**没有默认值**：写错了不会报错，只会让召回悄悄退化。
	 *
	 * `match` 会被校验（向量集的维度在第一次 `VADD` 时定死，换编码器必须换 key）；
	 * `answer` 这里只做合法性检查——答案向量不进向量集，它躺在 entry hash 里，
	 * 只被「已经被重排选中的那一条」用到，是点查不是检索。
	 */
	readonly dimensions: { readonly match: number; readonly answer: number };
	/** key 前缀，默认 `semcache`。换编码器就换一个，等同于 pgvector 那边换表名 */
	readonly namespace?: string;
	/**
	 * 用 HNSW 近似检索。**默认关闭**，也就是 scope 内精确 KNN（`VSIM ... TRUTH`）。
	 *
	 * 理由和 pgvector 那边一样：一个 scope 通常几百到几千条，精确扫够快，
	 * 而且召回集就是真召回集。开了近似之后带 `FILTER` 的检索可能返回不足 `limit` 条。
	 */
	readonly ann?: boolean;
	readonly now?: () => number;
}

/**
 * 「永不过期」在 `VSIM` 的 `FILTER` 里没法表达——属性缺失会让整个表达式为假，
 * 元素直接被跳过。所以属性里落一个哨兵值。**真值永远以 entry hash 为准**，
 * 属性只参与过滤，两者不会有歧义。
 */
const NEVER = Number.MAX_SAFE_INTEGER;

/** 顺序即 `HMGET` 的返回顺序，改一个就得连 Lua 里那份一起改 */
const FIELDS = [
	"id",
	"scope",
	"match_text",
	"match_hash",
	"match_vector",
	"kind",
	"answer",
	"plan",
	"answer_vector",
	"source_ids",
	"source_version",
	"created_at",
	"expires_at",
	"meta",
] as const;

/** Lua 里拼 `HMGET` 用的字面量列表 */
const LUA_FIELDS = FIELDS.map(f => `'${f}'`).join(", ");

/** 命名空间会被拼进 key 和 Lua 脚本，先验一遍 */
function assertNamespace(namespace: string): void {
	if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(namespace)) {
		throw new Error(
			`命名空间 ${JSON.stringify(namespace)} 不合法。只允许字母、数字、下划线、点和连字符，且不能以连字符或点开头。`,
		);
	}
}

function asArray(reply: unknown): Array<unknown> {
	return Array.isArray(reply) ? reply : [];
}

/**
 * 回复里的 bulk string 必须已经是字符串。**Buffer 模式的驱动会在这里炸，这是故意的** ——
 * `String(buffer)` 会拿到逗号分隔的字节，向量和 JSON 全变成垃圾，而且一路不报错。
 */
function asText(value: unknown): string {
	if (value === null || value === undefined || value === false) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
	throw new TypeError(
		`Redis 回复里出现了非字符串（${Object.prototype.toString.call(value)}）。` +
			`这个 store 要求驱动按字符串解码回复——node-redis 默认如此，ioredis 用 call 而不是 callBuffer。`,
	);
}

function parseNumberArray(value: string): Array<number> {
	if (value === "") return [];
	const parsed: unknown = JSON.parse(value);
	return Array.isArray(parsed) ? parsed.map(Number) : [];
}

function parseStringArray(value: string): Array<string> {
	if (value === "") return [];
	const parsed: unknown = JSON.parse(value);
	return Array.isArray(parsed) ? parsed.map(String) : [];
}

function parseRecord(value: string): Record<string, string> {
	if (value === "") return {};
	const parsed: unknown = JSON.parse(value);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = String(v);
	return out;
}

/** `HMGET` 回来的 14 个值 → 条目。任何一个字段缺失都当作条目不存在。 */
function toEntry(values: ReadonlyArray<unknown>): CacheEntry | null {
	if (values.length < FIELDS.length) return null;
	const at = (name: (typeof FIELDS)[number]): string => asText(values[FIELDS.indexOf(name)]);
	if (values[0] === null || values[0] === undefined || values[0] === false) return null;
	const kind = at("kind");
	const expiresAt = at("expires_at");
	const meta = at("meta");
	return {
		id: at("id"),
		scope: at("scope"),
		matchText: at("match_text"),
		matchHash: at("match_hash"),
		matchVector: parseNumberArray(at("match_vector")),
		kind: kind === "plan" ? "plan" : "answer",
		answer: at("answer"),
		plan: parseRecord(at("plan")),
		answerVector: parseNumberArray(at("answer_vector")),
		sourceIds: parseStringArray(at("source_ids")),
		sourceVersion: at("source_version"),
		createdAt: Number(at("created_at")),
		// 空串是「没有」，不是 0 —— createdAt 用不着这个区分，expiresAt 用得着
		expiresAt: expiresAt === "" ? null : Number(expiresAt),
		meta: meta === "" ? undefined : parseRecord(meta),
	};
}

/**
 * 写入。**先查重再写**：接口要求 id 重复必须抛错，
 * 而 `VADD` 对已存在的元素是覆盖，`HSET` 也是，两个都不会自己报。
 */
const SCRIPT_PUT = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 'DUP' end
local v = {KEYS[1], 'VALUES', tostring(#ARGV - 5)}
for i = 6, #ARGV do v[#v + 1] = ARGV[i] end
v[#v + 1] = ARGV[1]
v[#v + 1] = 'NOQUANT'
redis.call('VADD', unpack(v))
redis.call('VSETATTR', KEYS[1], ARGV[1], ARGV[2])
local f = cjson.decode(ARGV[4])
local h = {KEYS[2]}
for i = 1, #f do h[#h + 1] = f[i] end
redis.call('HSET', unpack(h))
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
redis.call('SADD', KEYS[5], ARGV[1])
for _, k in ipairs(cjson.decode(ARGV[5])) do redis.call('SADD', k, ARGV[1]) end
return 'OK'
`;

/**
 * 删除。`evict` / `evictBySource` / `clearScope` / `clear` 四个入口都走它 ——
 * 差别只在「这批 id 从哪来」，所以枚举也放进脚本里，整批删除因此是原子的。
 */
const SCRIPT_EVICT = `
local ids
if ARGV[2] == 'set' then ids = redis.call('SMEMBERS', ARGV[3])
elseif ARGV[2] == 'zset' then ids = redis.call('ZRANGE', ARGV[3], 0, -1)
else ids = {} for i = 3, #ARGV do ids[#ids + 1] = ARGV[i] end end
local n = 0
for _, id in ipairs(ids) do
  local ek = ARGV[1] .. ':e:' .. id
  local m = redis.call('HMGET', ek, 'scope', 'match_hash', 'source_ids')
  if m[1] then
    redis.call('VREM', KEYS[1], id)
    redis.call('DEL', ek)
    redis.call('ZREM', KEYS[2], id)
    redis.call('ZREM', ARGV[1] .. ':h:' .. m[1] .. ':' .. m[2], id)
    redis.call('SREM', ARGV[1] .. ':scope:' .. m[1], id)
    for _, s in ipairs(cjson.decode(m[3])) do redis.call('SREM', ARGV[1] .. ':src:' .. s, id) end
    n = n + 1
  end
end
return n
`;

/** 过期清理：拿 all zset 的全量，逐条判 expires_at，到点的收集起来交给删除逻辑 */
const SCRIPT_PURGE = `
local ids = redis.call('ZRANGE', KEYS[2], 0, -1)
local dead = {}
for _, id in ipairs(ids) do
  local exp = redis.call('HGET', ARGV[1] .. ':e:' .. id, 'expires_at')
  if exp and exp ~= '' and tonumber(exp) <= tonumber(ARGV[2]) then dead[#dead + 1] = id end
end
local n = 0
for _, id in ipairs(dead) do
  local ek = ARGV[1] .. ':e:' .. id
  local m = redis.call('HMGET', ek, 'scope', 'match_hash', 'source_ids')
  if m[1] then
    redis.call('VREM', KEYS[1], id)
    redis.call('DEL', ek)
    redis.call('ZREM', KEYS[2], id)
    redis.call('ZREM', ARGV[1] .. ':h:' .. m[1] .. ':' .. m[2], id)
    redis.call('SREM', ARGV[1] .. ':scope:' .. m[1], id)
    for _, s in ipairs(cjson.decode(m[3])) do redis.call('SREM', ARGV[1] .. ':src:' .. s, id) end
    n = n + 1
  end
end
return n
`;

/**
 * ② 精确匹配。zset 按 createdAt 排序，`ZREVRANGE` 出来就是
 * pgvector 那条 `ORDER BY created_at DESC, id DESC` —— 分数相同时
 * zset 按成员字典序，逆序正好是 id DESC。取第一条**未过期**的。
 */
const SCRIPT_BY_HASH = `
local ids = redis.call('ZREVRANGE', KEYS[1], 0, -1)
for _, id in ipairs(ids) do
  local ek = ARGV[1] .. ':e:' .. id
  local exp = redis.call('HGET', ek, 'expires_at')
  if exp and (exp == '' or tonumber(exp) > tonumber(ARGV[2])) then
    return redis.call('HMGET', ek, ${LUA_FIELDS})
  end
end
return nil
`;

/** `all()` 要的是原始状态，**含已过期未清理的**，顺序同 pgvector 的 `ORDER BY created_at, id` */
const SCRIPT_ALL = `
local ids = redis.call('ZRANGE', KEYS[1], 0, -1)
local out = {}
for _, id in ipairs(ids) do
  out[#out + 1] = redis.call('HMGET', ARGV[1] .. ':e:' .. id, ${LUA_FIELDS})
end
return out
`;

/**
 * ③ 召回。**scope 与过期条件在 `FILTER` 里，不是捞回来在应用层筛** ——
 * 接口要求「过期条目即使还没被清理也绝不能返回」，应用层筛在 `COUNT` 下做不到：
 * 限制先生效，过期条目会挤掉本该返回的候选。
 *
 * 分数一律 `tostring` 之后再回：Lua 的 number 转 RESP 会被截成整数，
 * 直接回等于把所有相似度变成 0，而且不会报错。
 */
const SCRIPT_SEARCH = `
local q = {KEYS[1], 'VALUES', tostring(#ARGV - 4)}
for i = 5, #ARGV do q[#q + 1] = ARGV[i] end
q[#q + 1] = 'WITHSCORES'
q[#q + 1] = 'COUNT'
q[#q + 1] = ARGV[2]
if ARGV[4] ~= '' then q[#q + 1] = ARGV[4] end
q[#q + 1] = 'FILTER'
q[#q + 1] = ARGV[3]
local hits = redis.call('VSIM', unpack(q))
local out = {}
for i = 1, #hits, 2 do
  local row = redis.call('HMGET', ARGV[1] .. ':e:' .. hits[i], ${LUA_FIELDS})
  row[${FIELDS.length + 1}] = tostring(hits[i + 1])
  out[#out + 1] = row
end
return out
`;

export function createRedisVectorSetCacheStore(
	options: RedisVectorSetCacheStoreOptions,
): InspectableCacheStore & { ensureSchema(): Promise<void> } {
	const namespace = options.namespace ?? "semcache";
	assertNamespace(namespace);
	const { redis, dimensions } = options;
	const now = options.now ?? (() => Date.now());

	if (!Number.isInteger(dimensions.match) || dimensions.match <= 0) {
		throw new Error(`match 向量维度必须是正整数，收到 ${String(dimensions.match)}`);
	}
	if (!Number.isInteger(dimensions.answer) || dimensions.answer <= 0) {
		throw new Error(`answer 向量维度必须是正整数，收到 ${String(dimensions.answer)}`);
	}

	/**
	 * 六个结构。**只有第一个是 Redis 给的，其余五个是这里自己维护的二级索引** ——
	 * 关系库免费给的东西，在这里全部变成写路径上的一致性责任。
	 */
	const keys = {
		/** 向量集：元素是条目 id，属性是 `{scope, expires_at}`，供 `VSIM` 的 FILTER 用 */
		vector: `${namespace}:v`,
		/** 条目本体。向量集只装向量，答案、来源、meta 这些都在这里 */
		entry: (id: string) => `${namespace}:e:${id}`,
		/** 全量 id，score = createdAt。`all()` 的顺序就是它 */
		all: `${namespace}:all`,
		/** ② 精确匹配的入口，score = createdAt，用来复现 `ORDER BY created_at DESC` */
		byHash: (scope: string, hash: string) => `${namespace}:h:${scope}:${hash}`,
		/** `clearScope` 要按 scope 枚举，向量集给不了 */
		scope: (scope: string) => `${namespace}:scope:${scope}`,
		/** ⑤ 语料改版时按资料 id 反查，等价于 pgvector 那边的 GIN 索引 */
		source: (sourceId: string) => `${namespace}:src:${sourceId}`,
	};

	async function evalScript(script: string, keyList: ReadonlyArray<string>, argv: ReadonlyArray<string>): Promise<unknown> {
		return redis.sendCommand(["EVAL", script, String(keyList.length), ...keyList, ...argv]);
	}

	/** 删除的四个入口只差「这批 id 从哪来」，枚举放进脚本里，整批因此是原子的 */
	async function evictBy(mode: "ids" | "set" | "zset", rest: ReadonlyArray<string>): Promise<number> {
		const done = await evalScript(SCRIPT_EVICT, [keys.vector, keys.all], [namespace, mode, ...rest]);
		return Number(done ?? 0);
	}

	/** 向量分量交出去之前一律转成字符串，非有限值落 0（同内存实现对零向量的处理） */
	function vectorArgs(vector: ReadonlyArray<number>): Array<string> {
		return vector.map(v => (Number.isFinite(v) ? String(v) : "0"));
	}

	return {
		/**
		 * 幂等，可以直接放在启动路径上。
		 *
		 * 这里没有「建表」可做 —— 向量集在第一次 `VADD` 时才诞生，维度也在那时定死。
		 * 所以它做的是两件校验：模块在不在，以及已有的向量集维度对不对得上。
		 */
		async ensureSchema(): Promise<void> {
			try {
				await redis.sendCommand(["VCARD", keys.vector]);
			} catch (err) {
				const message = String(err);
				if (/unknown command/iu.test(message)) {
					throw new Error(
						`这个 Redis 没有 vectorset（VADD/VSIM）。需要 Redis 8 或更高——它是内核自带的，` +
							`用 MODULE LIST 看有没有 vectorset。原始错误：${message}`,
					);
				}
				throw err;
			}

			const info = asArray(await redis.sendCommand(["VINFO", keys.vector]));
			for (let i = 0; i + 1 < info.length; i += 2) {
				if (asText(info[i]) !== "vector-dim") continue;
				const actual = Number(asText(info[i + 1]));
				if (Number.isFinite(actual) && actual !== dimensions.match) {
					throw new Error(
						`${keys.vector} 是 ${actual} 维，但当前编码器给出 ${dimensions.match} 维。` +
							`换编码器就得换 key——删掉旧的或用 namespace 选项换一个，` +
							`混着用等于把两个向量空间的条目堆在一起。`,
					);
				}
			}
		},

		async getByHash(scope, matchHash) {
			const found = await evalScript(SCRIPT_BY_HASH, [keys.byHash(scope, matchHash)], [namespace, String(now())]);
			return found === null || found === undefined ? null : toEntry(asArray(found));
		},

		async getById(id) {
			const values = asArray(await redis.sendCommand(["HMGET", keys.entry(id), ...FIELDS]));
			const entry = toEntry(values);
			if (entry === null) return null;
			// 读路径看不见过期条目。要看原始状态用 all()
			return entry.expiresAt === null || entry.expiresAt > now() ? entry : null;
		},

		async searchNearest(scope, vector, limit) {
			// scope 可能带引号或反斜杠，交给 JSON.stringify 转义，别自己拼
			const filter = `.scope == ${JSON.stringify(scope)} and .expires_at > ${now()}`;
			const hits = asArray(
				await evalScript(
					SCRIPT_SEARCH,
					[keys.vector],
					[namespace, String(limit), filter, options.ann ? "" : "TRUTH", ...vectorArgs(vector)],
				),
			);
			const out: Array<Candidate> = [];
			for (const hit of hits) {
				const row = asArray(hit);
				const entry = toEntry(row);
				if (entry === null) continue;
				// VSIM 给的是 (1 + 余弦) / 2，取回余弦才等于 VectorMath.cosine
				const score = Number(asText(row[FIELDS.length]));
				const similarity = Number.isFinite(score) ? 2 * score - 1 : 0;
				out.push({ entry, similarity });
			}
			return out;
		},

		async put(entry) {
			const fields: Array<string> = [
				"id", entry.id,
				"scope", entry.scope,
				"match_text", entry.matchText,
				"match_hash", entry.matchHash,
				"match_vector", JSON.stringify(entry.matchVector),
				"kind", entry.kind,
				"answer", entry.answer,
				"plan", JSON.stringify(entry.plan),
				"answer_vector", JSON.stringify(entry.answerVector),
				"source_ids", JSON.stringify(entry.sourceIds),
				"source_version", entry.sourceVersion,
				"created_at", String(entry.createdAt),
				// 空串是「永不过期」。落 0 会让它变成「早就过期」
				"expires_at", entry.expiresAt === null ? "" : String(entry.expiresAt),
				"meta", entry.meta === undefined ? "" : JSON.stringify(entry.meta),
			];
			const attributes = JSON.stringify({ scope: entry.scope, expires_at: entry.expiresAt ?? NEVER });
			const done = await evalScript(
				SCRIPT_PUT,
				[
					keys.vector,
					keys.entry(entry.id),
					keys.all,
					keys.byHash(entry.scope, entry.matchHash),
					keys.scope(entry.scope),
				],
				[
					entry.id,
					attributes,
					String(entry.createdAt),
					JSON.stringify(fields),
					JSON.stringify(entry.sourceIds.map(keys.source)),
					...vectorArgs(entry.matchVector),
				],
			);
			if (asText(done) === "DUP") {
				throw new Error(`缓存条目 id 重复：${entry.id}。id 由库生成，重复只可能是生成器碰撞。`);
			}
		},

		async evict(id) {
			await evictBy("ids", [id]);
		},

		async evictBySource(sourceId) {
			return evictBy("set", [keys.source(sourceId)]);
		},

		async purgeExpired() {
			const done = await evalScript(SCRIPT_PURGE, [keys.vector, keys.all], [namespace, String(now())]);
			return Number(done ?? 0);
		},

		async clearScope(scope) {
			return evictBy("set", [keys.scope(scope)]);
		},

		async clear() {
			await evictBy("zset", [keys.all]);
			// 逐条删完这两个 key 本该已经自动消失，兜底一次，免得留下空壳挡住维度校验
			await redis.sendCommand(["DEL", keys.vector, keys.all]);
		},

		async all() {
			// 和内存实现一样，**不过滤过期条目** —— 这是给 UI 和断言看的原始状态
			const rows = asArray(await evalScript(SCRIPT_ALL, [keys.all], [namespace]));
			const out: Array<CacheEntry> = [];
			for (const row of rows) {
				const entry = toEntry(asArray(row));
				if (entry !== null) out.push(entry);
			}
			return out;
		},
	};
}
