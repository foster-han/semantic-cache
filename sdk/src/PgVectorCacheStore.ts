import { LFU_COUNT_CAP } from "./EvictionOrder.ts";
import type { CacheEntry, Candidate, InspectableCacheStore } from "./types/CacheStore.ts";
import type { EvictionConfig } from "./types/Eviction.ts";
import type { SqlExecutor } from "./types/SqlExecutor.ts";
import { assertFiniteVector } from "./VectorMath.ts";

/**
 * The pgvector implementation. Not one line of decision logic changes — `SemanticCache` knows
 * only the `CacheStore` interface.
 *
 * Three constraints that cannot be skipped, all of them written into the SQL:
 *
 * 1. **Scope and expiry must be in the WHERE clause**, never fetched back and filtered in the
 *    application. The interface requires that an expired row is never returned even before it
 *    has been purged — and application-side filtering cannot deliver that under a LIMIT: the
 *    LIMIT applies first, and expired rows crowd out the candidates that should have come back.
 * 2. **One vector column only**: `match_vector`, in PairEncoder space, used by ③'s recall. There
 *    was once an `answer_vector` column in ⑥'s passage space; when ⑥ was removed the column
 *    went with it.
 * 3. **Similarity is `1 - (v <=> q)`**. pgvector's `<=>` is cosine distance, and its complement
 *    is exactly `VectorMath.cosine`, so the memory implementation and a real database rank
 *    recall the same way.
 *
 * **One real precision difference, not a bug to fix**: a `vector` column is float4 while a JS
 * number is float8. A vector is rounded to single precision on write (a measured round-trip
 * deviation of about 6e-8), so a similarity computed inside the library does not match a pure
 * in-memory run bit for bit.
 * The magnitude is far below any calibrated threshold's spacing, but **a sample sitting exactly
 * on a threshold can fall to the other side** — so calibrate and verify a threshold on the same
 * backend. pgvector has no float8 vector type; this is not something a different spelling gets
 * around. lab/scripts/storeConformance.ts encodes it as a criterion.
 */
export interface PgVectorCacheStoreOptions {
	readonly sql: SqlExecutor;
	/**
	 * The two vector columns' dimension. **No default**: getting it wrong raises no error and only
	 * degrades recall quietly, so the caller has to measure it off their own encoder and pass it in.
	 */
	readonly dimensions: { readonly match: number };
	/** Table name, optionally schema-qualified (`public.semantic_cache`). Defaults to `semantic_cache`. */
	readonly table?: string;
	/**
	 * Build an HNSW approximate index. **Off by default**, meaning exact KNN within a scope.
	 *
	 * A scope usually holds a few hundred to a few thousand entries, which an exact scan handles
	 * easily, and the recall set is then the real recall set. With ANN on, a vector search carrying
	 * a WHERE clause takes neighbours first and filters after, and may return fewer than `limit`
	 * rows — pgvector 0.8 onward can mitigate that with `SET hnsw.iterative_scan = relaxed_order`,
	 * but that is an operational decision to be tuned alongside `hnsw.max_scan_tuples` and not one
	 * the library should make for you.
	 */
	readonly ann?: boolean;
	readonly now?: () => number;
	/** Capacity eviction. Omitted means no eviction — TTL and explicit invalidation only. */
	readonly eviction?: EvictionConfig;
}

/** A table name can only come from code or an environment variable, but it is interpolated into SQL, so validate it first. */
function assertIdentifier(table: string): void {
	if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/u.test(table)) {
		throw new Error(
			`Table name ${JSON.stringify(table)} is not valid. Only lowercase letters, digits and underscores are allowed, optionally with a single schema prefix such as public.semantic_cache.`,
		);
	}
}

/**
 * pgvector's text input format is exactly `[1,2,3]`, so no extra dependency is needed to serialize it.
 *
 * NaN and Infinity are caught up front: interpolated into SQL they produce a low-level parse
 * error from pgvector whose stack gives no hint that the real cause was an encoder returning a
 * non-finite number. The check itself lives in `assertFiniteVector`, shared by all three
 * backends — previously only this one threw and the other two each handled the same input
 * silently.
 */
function toVectorLiteral(name: string, vector: ReadonlyArray<number>): string {
	assertFiniteVector(name, vector);
	return `[${vector.join(",")}]`;
}

/** It reads back in the same format, which happens to be valid JSON for an array. */
function fromVectorLiteral(value: unknown): Array<number> {
	if (value === null || value === undefined) {
		return [];
	}
	if (Array.isArray(value)) {
		return value.map(Number);
	}
	if (typeof value !== "string") {
		return [];
	}
	/**
	 * **One dirty row must not blow up the whole read path.**
	 *
	 * What pgvector writes is always a valid literal, but this column has had other writers —
	 * hand-edited data, logical replication and old migration scripts all reach it. A bare
	 * `JSON.parse` throws a SyntaxError whose stack names neither table nor row, and the caller gets
	 * a failed request rather than one missing candidate.
	 *
	 * Returning an empty vector fails benignly and visibly: recall similarity is computed in SQL
	 * (`1 - (match_vector <=> q)`) and does not read this value, and when a vector reads back empty
	 * ③'s recheck still decides by scope and text, so it cannot silently return a wrong answer.
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

/** A bigint column comes back as a string from node-pg, and without conversion `expiresAt > now` becomes a string comparison. */
function readNumber(row: Record<string, unknown>, key: string): number {
	return Number(row[key]);
}

function readNullableNumber(row: Record<string, unknown>, key: string): number | null {
	const value = row[key];
	return value === null || value === undefined ? null : Number(value);
}

function readRecord(row: Record<string, unknown>, key: string): Record<string, string> {
	const value = row[key];
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		out[k] = String(v);
	}
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
		createdAt: readNumber(row, "created_at"),
		expiresAt: readNullableNumber(row, "expires_at"),
		meta: row.meta === null || row.meta === undefined ? undefined : readRecord(row, "meta"),
		lastUsedAt: readNullableNumber(row, "last_used_at") ?? undefined,
		useCount: readNullableNumber(row, "use_count") ?? undefined,
	};
}

/**
 * The columns written, **in the same order as the value array in `put`**.
 *
 * Both the placeholders and the value count derive from here, and none of it is written by hand
 * — writing it by hand desynchronized it once already: when ⑥ was removed, `answer_vector` was
 * deleted here and one element was dropped from the value array, but `$1…$16` in the `VALUES`
 * clause was not updated, leaving 16 expressions against 15 columns and Postgres reporting
 * "INSERT has more expressions than target columns".
 *
 * **Neither existing net catches this class of drift**: `tsc` cannot see SQL inside a template
 * string, and the memory backend's unit tests emit no SQL at all — it surfaces only against a
 * real database, which is to say only once the application is running. Derived, renaming or
 * adding a column carries the placeholders along, and a value array with one element too few
 * or too many is a type error.
 */
const COLUMN_LIST = [
	"id",
	"scope",
	"match_text",
	"match_hash",
	"match_vector",
	"kind",
	"answer",
	"plan",
	"created_at",
	"expires_at",
	"meta",
	"last_used_at",
	"use_count",
] as const;

/**
 * Columns that need an explicit type annotation. The parameters are sent as text and Postgres
 * cannot infer these — a mistyped key is a type error rather than a silently missing `::vector`.
 */
const COLUMN_CASTS: Readonly<Partial<Record<(typeof COLUMN_LIST)[number], string>>> = {
	match_vector: "::vector",
	plan: "::jsonb",
	meta: "::jsonb",
};

const COLUMNS = COLUMN_LIST.join(", ");
const INSERT_PLACEHOLDERS = COLUMN_LIST.map((column, i) => `$${i + 1}${COLUMN_CASTS[column] ?? ""}`).join(", ");

/** The shape of the value array: its length is pinned to `COLUMN_LIST`, and one element too few or too many does not compile. */
type SameShape<T extends ReadonlyArray<unknown>> = { [K in keyof T]: unknown };
type InsertValues = SameShape<typeof COLUMN_LIST>;

/** `vector(384)` to 384; null when the column is not a vector. */
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
	 * The **retention priority** during eviction: whatever sorts first is kept, and everything past
	 * `OFFSET capacity` is deleted.
	 *
	 * All three deterministic policies carry `id` as a secondary key — with writes in the same
	 * millisecond, or equal use counts, an unordered result makes which row gets deleted an
	 * implementation detail, and the three backends would answer differently. `rr` is the
	 * exception, since randomness is its whole semantics.
	 *
	 * `lfu` falls back to LRU on equal counts: pure LFU lets an old entry that banked enough uses
	 * early on stay forever.
	 *
	 * **An entry with no accounting counts as used once, not zero times.** The write is itself a
	 * use; counted as zero it sorts behind every touched entry in the retention priority, so when a
	 * scope is full **a freshly written entry is deleted immediately by the eviction it triggered
	 * itself** — the entryId `resolve` returns points at a record that no longer exists, and that
	 * question can never establish itself in this scope. Counted as one it ties with entries used
	 * exactly once, and LRU breaks the tie in the newer entry's favour.
	 *
	 * This solves only the half where a new entry cannot get in; an old, heavily used entry crowding
	 * out new ones is inherent to LFU and takes decay to treat, which is not done here.
	 */
	const keepOrderSql =
		eviction?.policy === "lru"
			? "COALESCE(last_used_at, created_at) DESC, id DESC"
			: eviction?.policy === "lfu"
				? `LEAST(COALESCE(use_count, 1), ${LFU_COUNT_CAP}) DESC, COALESCE(last_used_at, created_at) DESC, id DESC`
				: eviction?.policy === "rr"
					? "random()"
					: "created_at DESC, id DESC";
	// An index name cannot carry a schema prefix but must follow the table name, so two tables' indexes do not collide
	const bare = table.includes(".") ? table.slice(table.indexOf(".") + 1) : table;

	if (!Number.isInteger(dimensions.match) || dimensions.match <= 0) {
		throw new Error(`The match vector dimension must be a positive integer, received ${String(dimensions.match)}`);
	}

	/**
	 * When the table already exists, check that the dimension matches.
	 *
	 * With a new encoder — say e5-small at 384 dimensions replaced by base at 768 — against the old
	 * table, inserts throw a low-level pgvector error at runtime whose stack gives no hint that the
	 * model changed. This catches it early and says plainly what to do.
	 */
	async function assertDimensions(): Promise<void> {
		const found = await sql.query(
			`SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS declared
			 FROM pg_attribute a
			 WHERE a.attrelid = to_regclass($1) AND a.attname = 'match_vector'`,
			[table],
		);
		for (const row of found.rows) {
			const column = readString(row, "attname");
			const actual = parseVectorDimension(readString(row, "declared"));
			const expected = dimensions.match;
			if (actual !== null && actual !== expected) {
				throw new Error(
					`${table}.${column} is vector(${actual}), but the current encoder produces ${expected} dimensions. ` +
						"Entries from two vector spaces cannot share one table, so no table is altered automatically. " +
						`There are two ways out: (a) use a different table — the table option or the SEMCACHE_TABLE ` +
						`environment variable, for instance ${table}_${expected}; or (b) DROP TABLE ${table} if the ` +
						"old one is no longer wanted. The usual cause is one table having been used by another " +
						"encoder first (a 256-dimension stub, or e5-small at 384).",
				);
			}
		}
	}

	/**
	 * Squeeze back to the capacity limit. **`put` and `evictOverCapacity` share this one path** —
	 * the two were once duplicated verbatim, and missing one of them while changing the retention
	 * priority is exactly the silent inconsistency of evicting by A on write and by B on an
	 * explicit call.
	 *
	 * `ORDER BY <retention priority> OFFSET capacity` selects precisely the rows over the limit.
	 *
	 * **Capacity counts live rows.** The first half of the `UNION` collects the rows in this scope
	 * that have expired and merely have not been reaped by `purgeExpired` yet; the second half ranks
	 * retention priority among live rows only. Live and dead were once not distinguished, so an
	 * expired row held a slot and displaced a live entry while `ORDER BY` never looked at
	 * `expires_at` — and that expired row could go on displacing several more as long as its
	 * `last_used_at` was recent enough. The memory and Redis backends had the same defect, and all
	 * three were fixed together.
	 *
	 * **Count first and return 0 when under the limit** — the same shape as the Redis backend's
	 * `sizeOf` step. This used to issue the DELETE unconditionally: even under capacity it scanned
	 * the scope to reap expired rows, so every `put` paid for a delete on the hot path while memory
	 * and Redis cost nothing under capacity, and `evictOverCapacity()`'s return value diverged as
	 * well (pgvector reported the expired-row count, the other two reported 0). What is counted is
	 * **all rows**, expired included, matching the other two backends' pressure criterion — what
	 * happens to expired rows is decided by the `UNION` half above, not here.
	 *
	 * The cost is a window between the COUNT and the DELETE: a write slipping in between waits for
	 * the next `put` to be squeezed back. Eviction is best-effort by design (as is `purgeExpired`),
	 * and one extra retained row costs only memory — cheaper than scanning on every write.
	 */
	async function evictOverCapacityIn(scope: string): Promise<number> {
		if (!eviction) {
			return 0;
		}
		const size = await sql.query(`SELECT count(*) AS n FROM ${table} WHERE scope = $1`, [scope]);
		const total = size.rows.length === 0 ? 0 : readNumber(size.rows[0], "n");
		if (total <= eviction.capacity) {
			return 0;
		}
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
		/** Idempotent. Repeated calls have no side effects, so it can sit directly on the startup path. */
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
					created_at     bigint NOT NULL,
					expires_at     bigint,
					meta           jsonb,
					-- -- Accounting columns for lru/lfu. Always NULL under fifo/rr, and cost nothing while unwritten
					last_used_at   bigint,
					use_count      integer
				)`,
			);
			// Upgrading an old table: adding a column is idempotent and does not touch existing data
			await sql.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS last_used_at bigint`);
			await sql.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS use_count integer`);
			await assertDimensions();

			// ② exact match: scope plus hash locates the row directly, and the expiry check rides the index without a heap fetch
			await sql.query(
				`CREATE INDEX IF NOT EXISTS ${bare}_scope_hash_idx ON ${table} (scope, match_hash) INCLUDE (expires_at)`,
			);
			// ③'s recall pre-filter: narrow by scope first, then compute vectors
			await sql.query(`CREATE INDEX IF NOT EXISTS ${bare}_scope_expires_idx ON ${table} (scope, expires_at)`);
			/**
			 * An older table has `source_ids` / `source_version` columns and a GIN index over the
			 * first — the per-document dimension, since removed. **The index is dropped here and the
			 * columns are not.**
			 *
			 * The index holds no data of its own and is now pure write-amplification, so dropping it
			 * is free. Dropping the columns would delete rows' content during `ensureSchema()`, which
			 * runs at startup: a library must not silently migrate away someone's data. Both are `NOT
			 * NULL DEFAULT`, so inserts that no longer mention them keep working; drop them by hand
			 * once you are sure nothing reads them.
			 */
			await sql.query(`DROP INDEX IF EXISTS ${bare}_source_ids_idx`);
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
				[scope, toVectorLiteral("query vector", vector), now(), limit],
			);
			return found.rows.map((row): Candidate => {
				const similarity = readNumber(row, "similarity");
				// A zero vector's cosine distance is NaN in pgvector. The memory implementation returns 0 here, so this matches.
				return { entry: toEntry(row), similarity: Number.isFinite(similarity) ? similarity : 0 };
			});
		},

		async put(entry) {
			// The order must match COLUMN_LIST; the count is pinned by InsertValues
			const values: InsertValues = [
				entry.id,
				entry.scope,
				entry.matchText,
				entry.matchHash,
				toVectorLiteral("matchVector ", entry.matchVector),
				entry.kind,
				entry.answer,
				JSON.stringify(entry.plan),
				entry.createdAt,
				entry.expiresAt,
				entry.meta === undefined ? null : JSON.stringify(entry.meta),
				entry.lastUsedAt ?? null,
				entry.useCount ?? null,
			];
			await sql.query(`INSERT INTO ${table} (${COLUMNS}) VALUES (${INSERT_PLACEHOLDERS})`, values);
			if (eviction) {
				await evictOverCapacityIn(entry.scope);
			}
		},

		async evict(id) {
			await sql.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
		},

		async touch(id) {
			// fifo/rr need no accounting — this does not even make a round trip
			if (eviction?.policy !== "lru" && eviction?.policy !== "lfu") {
				return;
			}
			// The entry may have just been evicted concurrently, so 0 rows affected is the normal result and does not throw
			await sql.query(
				`UPDATE ${table} SET last_used_at = $2, use_count = COALESCE(use_count, 1) + 1 WHERE id = $1`,
				[id, now()],
			);
		},

		async evictOverCapacity(scope) {
			return evictOverCapacityIn(scope);
		},

		async purgeExpired() {
			const done = await sql.query(`DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= $1`, [
				now(),
			]);
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
			// Like the memory implementation, this **does not filter expired entries** — it is the raw state, for UIs and assertions
			const found = await sql.query(`SELECT ${COLUMNS} FROM ${table} ORDER BY created_at, id`);
			return found.rows.map(toEntry);
		},
	};
}
