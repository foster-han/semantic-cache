/**
 * 最小 SQL 端口。
 *
 * SDK 是零依赖的，所以这里**不 import `pg`** —— 由调用方把自己的连接池传进来。
 * `pg` 的 `Pool` 和 `Client` 天然就是这个形状，不用写适配器：
 *
 *   const pool = new Pool({ connectionString });
 *   createPgVectorCacheStore({ sql: pool, dimensions: { match: 384, answer: 384 } });
 *
 * 换别的驱动（postgres.js、Hyperdrive…）只要包一层同形状的对象。
 *
 * 刻意不做成泛型：泛型签名在结构化赋值时容易和 `pg` 自己的类型参数约束打架，
 * 那会逼调用方写 `as unknown as SqlExecutor`。行的取值在 PgVectorCacheStore
 * 里用带类型的读取函数收口，比把复杂度推给调用方划算。
 */
export interface SqlRows {
	readonly rows: Array<Record<string, unknown>>;
	/** 受影响行数。驱动不给时为 null */
	readonly rowCount: number | null;
}

export interface SqlExecutor {
	query(text: string, values?: ReadonlyArray<unknown>): Promise<SqlRows>;
}
