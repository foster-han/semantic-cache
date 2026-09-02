/**
 * Minimal SQL interface.
 *
 * The SDK is dependency-free, so this **does not import `pg`** — the caller passes their own pool
 * in. `pg`'s `Pool` and `Client` already have this shape, so no adapter is needed:
 *
 *   const pool = new Pool({ connectionString });
 *   createPgVectorCacheStore({ sql: pool, dimensions: { match: 384, answer: 384 } });
 *
 * Another driver (postgres.js, Hyperdrive, …) only needs a wrapper of the same shape.
 *
 * Deliberately not generic: a generic signature tends to collide with `pg`'s own type-parameter
 * constraints during structural assignment, which forces callers to write
 * `as unknown as SqlExecutor`. Row values are funneled through typed read helpers inside
 * `PgVectorCacheStore` instead, which is a better trade than pushing the complexity outward.
 */
export interface SqlRows {
	readonly rows: Array<Record<string, unknown>>;
	/** Rows affected. Null when the driver does not report it. */
	readonly rowCount: number | null;
}

export interface SqlExecutor {
	query(text: string, values?: ReadonlyArray<unknown>): Promise<SqlRows>;
}
