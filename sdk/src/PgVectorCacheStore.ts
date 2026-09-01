import type { Candidate, CacheEntry, InspectableCacheStore } from "./types/CacheStore.ts";
import { LFU_COUNT_CAP } from "./EvictionOrder.ts";
import { assertFiniteVector } from "./VectorMath.ts";
import type { EvictionConfig } from "./types/Eviction.ts";
import type { SqlExecutor } from "./types/SqlExecutor.ts";

/**
 * pgvector 实现。判定逻辑一行都不用改 —— `SemanticCache` 只认 `CacheStore` 接口。
 *
 * 三处不能省的约束，都写进了 SQL：
 *
 * 1. **scope 与过期条件必须在 WHERE 里**，不能捞回来在应用层过滤。接口文档要求
 *    「过期行即使还没被清理也绝不能返回」—— 应用层过滤在分页/LIMIT 下做不到这点：
 *    LIMIT 先生效，过期行会挤掉本该返回的候选。
 * 2. **两个向量在不同空间，落两列**。`match_vector` 是 PairEncoder 空间（③ 召回用），
 *    `answer_vector` 是 RetrievalEncoder 的 passage 空间（⑥ 跟检索片段比）。
 *    维度可以不同，索引也必须分开——混用是这套东西最隐蔽的失效方式。
 * 3. **相似度用 `1 - (v <=> q)`**。pgvector 的 `<=>` 是余弦距离，取补正好等于
 *    `VectorMath.cosine`，内存实现与真库的召回排序因此一致。
 *
 * **一处真实的精度差异，别当成 bug 去修**：`vector` 列是 float4，而 JS 的 number
 * 是 float8。向量写进去就被舍到单精度（实测往返偏差约 6e-8），因此库内算出的
 * 相似度、以及读回来的 `answerVector` 参与的 ⑥ 支撑度，都和纯内存跑不会逐位相同。
 * 量级远小于任何标定出来的阈值间距，但**恰好压在阈值上的样本可能倒向另一边** ——
 * 阈值标定该在哪个后端上做，就在哪个后端上验。pgvector 没有 float8 的向量类型，
 * 这不是能通过换写法绕开的东西。lab/scripts/storeConformance.ts 把这条写成了判据。
 */
export interface PgVectorCacheStoreOptions {
	readonly sql: SqlExecutor;
	/**
	 * 两个向量列的维度。**没有默认值**：写错了不会报错，只会让召回悄悄退化，
	 * 所以必须由调用方从自己的编码器上量出来传进来。
	 */
	readonly dimensions: { readonly match: number; readonly answer: number };
	/** 表名，可带 schema 前缀（`public.semantic_cache`）。默认 `semantic_cache` */
	readonly table?: string;
	/**
	 * 建 HNSW 近似索引。**默认关闭**，也就是 scope 内精确 KNN。
	 *
	 * 一个 scope 的缓存条目通常是几百到几千条，精确扫完全够快，而且召回集就是真
	 * 召回集。开了 ANN 之后带 WHERE 的向量检索会先取近邻再过滤，可能返回不足
	 * `limit` 条——pgvector 0.8 起可以用 `SET hnsw.iterative_scan = relaxed_order`
	 * 缓解，但那是要连同 `hnsw.max_scan_tuples` 一起调的运维决定，不该由库替你做。
	 */
	readonly ann?: boolean;
	readonly now?: () => number;
	/** 容量淘汰。不给就不淘汰 —— 只靠 TTL 与显式失效 */
	readonly eviction?: EvictionConfig;
}

/** 表名只可能来自代码或环境变量，但它是拼进 SQL 的——必须先验一遍。 */
function assertIdentifier(table: string): void {
	if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/u.test(table)) {
		throw new Error(
			`表名 ${JSON.stringify(table)} 不合法。只允许小写字母、数字、下划线，可带一级 schema 前缀（如 public.semantic_cache）。`,
		);
	}
}

/**
 * pgvector 的文本输入格式就是 `[1,2,3]`，不需要额外依赖来序列化。
 *
 * NaN / Infinity 先拦下来：拼进 SQL 的话由 pgvector 抛一个底层解析错，
 * 堆栈里看不出真正的原因是编码器返回了非有限数。检查本身在 `assertFiniteVector`，
 * 三个后端共用一份 —— 先前只有这里抛，另两个后端各自静默处理了同一个输入。
 */
function toVectorLiteral(name: string, vector: ReadonlyArray<number>): string {
	assertFiniteVector(name, vector);
	return `[${vector.join(",")}]`;
}

/** 读回来是同一种格式，正好是合法 JSON 数组。 */
function fromVectorLiteral(value: unknown): Array<number> {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value.map(Number);
	if (typeof value !== "string") return [];
	/**
	 * **一条脏行不该让整个读路径炸掉。**
	 *
	 * pgvector 自己写出来的永远是合法字面量，但这一列不只有它写过 —— 手工改数据、
	 * 逻辑复制、老迁移脚本都碰得到。裸 `JSON.parse` 抛的是个 SyntaxError，堆栈里
	 * 看不出是哪张表哪一行，而调用方拿到的是「整次请求失败」而不是「少了一条候选」。
	 *
	 * 返回空向量的后果良性且可见：召回相似度是 SQL 算的（`1 - (match_vector <=> q)`），
	 * 不看这个值；答案向量为空时 ⑥ 走「判不了」—— 本次不复用，但也不驱逐。
	 * 和「缺证据不是有罪」是同一族取舍。
	 */
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.map(Number) : [];
	} catch {
		return [];
	}
}

function readString(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

/** bigint 列在 node-pg 里回来是字符串——不转会让 `expiresAt > now` 变成字符串比较。 */
function readNumber(row: Record<string, unknown>, key: string): number {
	return Number(row[key]);
}

function readNullableNumber(row: Record<string, unknown>, key: string): number | null {
	const value = row[key];
	return value === null || value === undefined ? null : Number(value);
}

function readStringArray(row: Record<string, unknown>, key: string): Array<string> {
	const value = row[key];
	return Array.isArray(value) ? value.map(String) : [];
}

function readRecord(row: Record<string, unknown>, key: string): Record<string, string> {
	const value = row[key];
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = String(v);
	return out;
}

function toEntry(row: Record<string, unknown>): CacheEntry {
	const kind = readString(row, "kind");
	return {
		id: readString(row, "id"),
		scope: readString(row, "scope"),
		matchText: readString(row, "match_text"),
		matchHash: readString(row, "match_hash"),
		matchVector: fromVectorLiteral(row.match_vector),
		kind: kind === "plan" ? "plan" : "answer",
		answer: readString(row, "answer"),
		plan: readRecord(row, "plan"),
		answerVector: fromVectorLiteral(row.answer_vector),
		sourceIds: readStringArray(row, "source_ids"),
		sourceVersion: readString(row, "source_version"),
		createdAt: readNumber(row, "created_at"),
		expiresAt: readNullableNumber(row, "expires_at"),
		meta: row.meta === null || row.meta === undefined ? undefined : readRecord(row, "meta"),
		lastUsedAt: readNullableNumber(row, "last_used_at") ?? undefined,
		useCount: readNullableNumber(row, "use_count") ?? undefined,
	};
}

const COLUMNS =
	"id, scope, match_text, match_hash, match_vector, kind, answer, plan, answer_vector, " +
	"source_ids, source_version, created_at, expires_at, meta, last_used_at, use_count";

/** `vector(384)` → 384；不是向量列时返回 null。 */
function parseVectorDimension(formattedType: string): number | null {
	const m = /^vector\((\d+)\)$/u.exec(formattedType.trim());
	return m ? Number(m[1]) : null;
}

export function createPgVectorCacheStore(
	options: PgVectorCacheStoreOptions,
): InspectableCacheStore & { ensureSchema(): Promise<void> } {
	const table = options.table ?? "semantic_cache";
	assertIdentifier(table);
	const { sql, dimensions } = options;
	const now = options.now ?? (() => Date.now());
	const eviction = options.eviction;

	/**
	 * 淘汰时的**保留优先级**：排在前面的先保住，`OFFSET capacity` 之后的删掉。
	 *
	 * 三种确定性策略都带 `id` 做次级键 —— 同毫秒写入、同使用次数时若不定序，
	 * 「删哪一条」就成了实现细节，三种后端会给出不同答案。`rr` 例外，
	 * 它的语义就是随机。
	 *
	 * `lfu` 在次数相同时退到 LRU：纯 LFU 会让早期攒够次数的老条目永远赖着不走。	 *
	 * **没记过账的条目按「用过一次」算，不是零次。**写入本身就是一次使用；算零次的话
	 * 它在保留优先级里排到所有被 touch 过的条目之后，于是 scope 满员时**新写进去的
	 * 条目会被自己触发的那次淘汰立刻删掉** —— `resolve` 返回的 entryId 指向一条已经
	 * 不存在的记录，而那个问题在这个 scope 里永远立不住。算一次之后它与「只用过一次」
	 * 的老条目打平，再由 LRU 破平（新的胜出）。
	 *
	 * 这只解掉「新条目进不来」那一半；「用得多的老条目压着新条目」是 LFU 固有的，
	 * 要衰减才治得了，这里没做。
	 */
	const keepOrderSql =
		eviction?.policy === "lru"
			? "COALESCE(last_used_at, created_at) DESC, id DESC"
			: eviction?.policy === "lfu"
				? `LEAST(COALESCE(use_count, 1), ${LFU_COUNT_CAP}) DESC, COALESCE(last_used_at, created_at) DESC, id DESC`
				: eviction?.policy === "rr"
					? "random()"
					: "created_at DESC, id DESC";
	// 索引名不能带 schema 前缀，但要跟着表名走，免得两张表的索引重名
	const bare = table.includes(".") ? table.slice(table.indexOf(".") + 1) : table;

	if (!Number.isInteger(dimensions.match) || dimensions.match <= 0) {
		throw new Error(`match 向量维度必须是正整数，收到 ${String(dimensions.match)}`);
	}
	if (!Number.isInteger(dimensions.answer) || dimensions.answer <= 0) {
		throw new Error(`answer 向量维度必须是正整数，收到 ${String(dimensions.answer)}`);
	}

	/**
	 * 建表已存在时，校验维度对不对得上。
	 *
	 * 换了编码器（比如从 384 维的 e5-small 换成 768 维的 base）而表还是老的，
	 * 插入会在运行时炸一个 pgvector 的底层报错，堆栈里看不出是模型换了。
	 * 这里提前拦下并直说该怎么办。
	 */
	async function assertDimensions(): Promise<void> {
		const found = await sql.query(
			`SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS declared
			 FROM pg_attribute a
			 WHERE a.attrelid = to_regclass($1) AND a.attname IN ('match_vector', 'answer_vector')`,
			[table],
		);
		for (const row of found.rows) {
			const column = readString(row, "attname");
			const actual = parseVectorDimension(readString(row, "declared"));
			const expected = column === "match_vector" ? dimensions.match : dimensions.answer;
			if (actual !== null && actual !== expected) {
				throw new Error(
					`${table}.${column} 是 vector(${actual})，但当前编码器给出 ${expected} 维。` +
						`两个向量空间的条目不能堆在一张表里，所以这里不会自动改表。出路二选一：` +
						`(a) 换一张表 —— table 选项或 SEMCACHE_TABLE 环境变量，比如 ${table}_${expected}；` +
						`(b) 旧表不要了就 DROP TABLE ${table}。` +
						`常见诱因是同一张表先被另一个编码器用过（stub 256 维 / e5-small 384 维）。`,
				);
			}
		}
	}

	/**
	 * 压回容量上限。**`put` 与 `evictOverCapacity` 共用这一条** —— 先前两处逐字重复，
	 * 改保留优先级时漏掉一处，就是「写入时按 A 淘汰、显式调用时按 B 淘汰」的静默不一致。
	 *
	 * `ORDER BY <保留优先级> OFFSET capacity` 选出的正是「超出上限的那些」。
	 *
	 * **容量数的是活行。** 前一半 `UNION` 先收掉这个 scope 里已过期、只是还没被
	 * `purgeExpired` 收走的行；后一半只在活行里排保留优先级。先前不分活死，于是
	 * 一条过期行占着一个名额把活条目顶掉，而 `ORDER BY` 根本不看 `expires_at` ——
	 * 那条过期行只要 `last_used_at` 够新就能接着顶掉好几条。内存与 Redis 后端
	 * 先前是同一个毛病，三处一起改。
	 *
	 * **先数一次，没超就直接返回 0** —— 和 Redis 后端的 `sizeOf` 那一步同一个形状。
	 * 先前这里无条件发 DELETE：容量以下也照样扫一遍 scope 收过期行，于是每次 `put`
	 * 都在热路径上付一次删除，而内存与 Redis 在容量以下是零成本；`evictOverCapacity()`
	 * 的返回值也因此分叉（pgvector 报过期行数，另两个报 0）。数的是**全部行**（含过期），
	 * 跟另两个后端的压力判据一致 —— 过期行怎么处置由上面那半 `UNION` 决定，不由这里。
	 *
	 * 代价是 COUNT 与 DELETE 之间有一个窗口：这中间挤进来的写入要等下一次 `put` 才
	 * 被压回容量。淘汰本来就是尽力而为的（`purgeExpired` 同理），而多留一条的后果
	 * 只是内存占用，比每次写入都扫一遍便宜。
	 */
	async function evictOverCapacityIn(scope: string): Promise<number> {
		if (!eviction) return 0;
		const size = await sql.query(`SELECT count(*) AS n FROM ${table} WHERE scope = $1`, [scope]);
		const total = size.rows.length === 0 ? 0 : readNumber(size.rows[0], "n");
		if (total <= eviction.capacity) return 0;
		const done = await sql.query(
			`DELETE FROM ${table} WHERE id IN (
			   SELECT id FROM ${table}
			     WHERE scope = $1 AND expires_at IS NOT NULL AND expires_at <= $3
			   UNION
			   SELECT id FROM (
			     SELECT id FROM ${table}
			       WHERE scope = $1 AND (expires_at IS NULL OR expires_at > $3)
			       ORDER BY ${keepOrderSql} OFFSET $2
			   ) AS over_capacity
			 )`,
			[scope, eviction.capacity, now()],
		);
		return done.rowCount ?? 0;
	}

	return {
		/** 幂等。反复调没有副作用，可以直接放在启动路径上。 */
		async ensureSchema(): Promise<void> {
			await sql.query("CREATE EXTENSION IF NOT EXISTS vector");
			await sql.query(
				`CREATE TABLE IF NOT EXISTS ${table} (
					id             text PRIMARY KEY,
					scope          text NOT NULL,
					match_text     text NOT NULL,
					match_hash     text NOT NULL,
					match_vector   vector(${dimensions.match}) NOT NULL,
					kind           text NOT NULL CHECK (kind IN ('answer', 'plan')),
					answer         text NOT NULL DEFAULT '',
					plan           jsonb NOT NULL DEFAULT '{}'::jsonb,
					answer_vector  vector(${dimensions.answer}),
					source_ids     text[] NOT NULL DEFAULT '{}',
					source_version text NOT NULL DEFAULT '',
					created_at     bigint NOT NULL,
					expires_at     bigint,
					meta           jsonb,
					-- lru/lfu 的记账列。fifo/rr 下永远是 NULL，不写就不占空间
					last_used_at   bigint,
					use_count      integer
				)`,
			);
			// 老表升级：加列是幂等的，不会碰已有数据
			await sql.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS last_used_at bigint`);
			await sql.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS use_count integer`);
			await assertDimensions();

			// ② 精确匹配：scope + hash 直接定位，过期判断跟着走索引不用回表
			await sql.query(
				`CREATE INDEX IF NOT EXISTS ${bare}_scope_hash_idx ON ${table} (scope, match_hash) INCLUDE (expires_at)`,
			);
			// ③ 召回的 pre-filter：先按 scope 砍小，再算向量
			await sql.query(`CREATE INDEX IF NOT EXISTS ${bare}_scope_expires_idx ON ${table} (scope, expires_at)`);
			// ⑤ 语料改版时按资料 id 批量失效
			await sql.query(`CREATE INDEX IF NOT EXISTS ${bare}_source_ids_idx ON ${table} USING gin (source_ids)`);
			if (options.ann) {
				await sql.query(
					`CREATE INDEX IF NOT EXISTS ${bare}_match_vector_idx ON ${table} USING hnsw (match_vector vector_cosine_ops)`,
				);
			}
		},

		async getByHash(scope, matchHash) {
			const found = await sql.query(
				`SELECT ${COLUMNS} FROM ${table}
				 WHERE scope = $1 AND match_hash = $2 AND (expires_at IS NULL OR expires_at > $3)
				 ORDER BY created_at DESC, id DESC
				 LIMIT 1`,
				[scope, matchHash, now()],
			);
			const row = found.rows[0];
			return row ? toEntry(row) : null;
		},

		async getById(id) {
			const found = await sql.query(
				`SELECT ${COLUMNS} FROM ${table} WHERE id = $1 AND (expires_at IS NULL OR expires_at > $2)`,
				[id, now()],
			);
			const row = found.rows[0];
			return row ? toEntry(row) : null;
		},

		async searchNearest(scope, vector, limit) {
			const found = await sql.query(
				`SELECT ${COLUMNS}, 1 - (match_vector <=> $2::vector) AS similarity
				 FROM ${table}
				 WHERE scope = $1 AND (expires_at IS NULL OR expires_at > $3)
				 ORDER BY match_vector <=> $2::vector
				 LIMIT $4`,
				[scope, toVectorLiteral("查询向量", vector), now(), limit],
			);
			return found.rows.map((row): Candidate => {
				const similarity = readNumber(row, "similarity");
				// 零向量在 pgvector 里余弦距离是 NaN。内存实现这时返回 0，保持一致。
				return { entry: toEntry(row), similarity: Number.isFinite(similarity) ? similarity : 0 };
			});
		},

		async put(entry) {
			await sql.query(
				`INSERT INTO ${table} (${COLUMNS})
				 VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8::jsonb, $9::vector, $10::text[], $11, $12, $13, $14::jsonb, $15, $16)`,
				[
					entry.id,
					entry.scope,
					entry.matchText,
					entry.matchHash,
					toVectorLiteral("matchVector ", entry.matchVector),
					entry.kind,
					entry.answer,
					JSON.stringify(entry.plan),
					// plan 条目没有答案向量。pgvector 存不了 0 维，落 NULL
					entry.answerVector.length === 0 ? null : toVectorLiteral("answerVector ", entry.answerVector),
					[...entry.sourceIds],
					entry.sourceVersion,
					entry.createdAt,
					entry.expiresAt,
					entry.meta === undefined ? null : JSON.stringify(entry.meta),
					entry.lastUsedAt ?? null,
					entry.useCount ?? null,
				],
			);
			if (eviction) await evictOverCapacityIn(entry.scope);
		},

		async evict(id) {
			await sql.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
		},

		async evictBySource(sourceId) {
			// `&&` 是数组重叠，走 GIN 索引；`source_ids` 里出现过这篇资料就失效
			const done = await sql.query(`DELETE FROM ${table} WHERE source_ids && ARRAY[$1]::text[]`, [sourceId]);
			return done.rowCount ?? 0;
		},

		async touch(id) {
			// fifo/rr 不需要记账 —— 这里连一次往返都不发
			if (eviction?.policy !== "lru" && eviction?.policy !== "lfu") return;
			// 条目可能刚被并发驱逐 —— 0 行受影响就是正常结果，不抛
			await sql.query(
				`UPDATE ${table} SET last_used_at = $2, use_count = COALESCE(use_count, 1) + 1 WHERE id = $1`,
				[id, now()],
			);
		},

		async evictOverCapacity(scope) {
			return evictOverCapacityIn(scope);
		},

		async purgeExpired() {
			const done = await sql.query(`DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= $1`, [now()]);
			return done.rowCount ?? 0;
		},

		async clearScope(scope) {
			const done = await sql.query(`DELETE FROM ${table} WHERE scope = $1`, [scope]);
			return done.rowCount ?? 0;
		},

		async clear() {
			await sql.query(`DELETE FROM ${table}`);
		},

		async all() {
			// 和内存实现一样，**不过滤过期条目** —— 这是给 UI 和断言看的原始状态
			const found = await sql.query(`SELECT ${COLUMNS} FROM ${table} ORDER BY created_at, id`);
			return found.rows.map(toEntry);
		},
	};
}
