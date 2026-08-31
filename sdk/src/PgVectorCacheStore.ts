import type { Candidate, CacheEntry, InspectableCacheStore } from "./types/CacheStore.ts";
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
}

/** 表名只可能来自代码或环境变量，但它是拼进 SQL 的——必须先验一遍。 */
function assertIdentifier(table: string): void {
	if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/u.test(table)) {
		throw new Error(
			`表名 ${JSON.stringify(table)} 不合法。只允许小写字母、数字、下划线，可带一级 schema 前缀（如 public.semantic_cache）。`,
		);
	}
}

/** pgvector 的文本输入格式就是 `[1,2,3]`，不需要额外依赖来序列化。 */
function toVectorLiteral(vector: ReadonlyArray<number>): string {
	return `[${vector.join(",")}]`;
}

/** 读回来是同一种格式，正好是合法 JSON 数组。 */
function fromVectorLiteral(value: unknown): Array<number> {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value.map(Number);
	if (typeof value !== "string") return [];
	const parsed: unknown = JSON.parse(value);
	return Array.isArray(parsed) ? parsed.map(Number) : [];
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
	};
}

const COLUMNS =
	"id, scope, match_text, match_hash, match_vector, kind, answer, plan, answer_vector, " +
	"source_ids, source_version, created_at, expires_at, meta";

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
					meta           jsonb
				)`,
			);
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
				[scope, toVectorLiteral(vector), now(), limit],
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
				 VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8::jsonb, $9::vector, $10::text[], $11, $12, $13, $14::jsonb)`,
				[
					entry.id,
					entry.scope,
					entry.matchText,
					entry.matchHash,
					toVectorLiteral(entry.matchVector),
					entry.kind,
					entry.answer,
					JSON.stringify(entry.plan),
					// plan 条目没有答案向量。pgvector 存不了 0 维，落 NULL
					entry.answerVector.length === 0 ? null : toVectorLiteral(entry.answerVector),
					[...entry.sourceIds],
					entry.sourceVersion,
					entry.createdAt,
					entry.expiresAt,
					entry.meta === undefined ? null : JSON.stringify(entry.meta),
				],
			);
		},

		async evict(id) {
			await sql.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
		},

		async evictBySource(sourceId) {
			// `&&` 是数组重叠，走 GIN 索引；`source_ids` 里出现过这篇资料就失效
			const done = await sql.query(`DELETE FROM ${table} WHERE source_ids && ARRAY[$1]::text[]`, [sourceId]);
			return done.rowCount ?? 0;
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
