import { lfuCount } from "./EvictionOrder.ts";
import type { CacheEntry, Candidate, InspectableCacheStore } from "./types/CacheStore.ts";
import type { EvictionConfig } from "./types/Eviction.ts";
import type { RedisExecutor } from "./types/RedisExecutor.ts";
import { assertFiniteVector } from "./VectorMath.ts";

/**
 * Redis implementation, on Redis 8's built-in **Vector Set** (`VADD` / `VSIM`) rather than
 * RediSearch. Not one line of decision logic changes — `SemanticCache` knows only the
 * `CacheStore` interface.
 *
 * The reason for vectorset over `FT.*` is practical: it lives in Redis 8's core and shows up in
 * `MODULE LIST` directly, with no separate Redis Stack install. Its cost is point 2 below.
 *
 * Four constraints that cannot be skipped:
 *
 * 1. **`NOQUANT` is mandatory.** `VADD` quantizes to Q8 by default, and int8's resolution is two
 *    orders of magnitude coarser than pgvector's float4, enough to shake recall order visibly.
 *    With `NOQUANT` added, `VINFO` reports `quant-type f32` and the measured round-trip deviation
 *    is about 4e-9, on par with pgvector.
 * 2. **Only `searchNearest` comes from the library; the other eight methods need secondary
 *    indexes built here.** A vector set is one key holding a set of (element, vector, attributes)
 *    — not a document store: there is no lookup by hash, no reverse lookup by source id, no
 *    per-scope count. So five extra structures are maintained here (see keys), and **the whole
 *    write path goes through Lua** — an orphaned index left behind by a multi-structure write
 *    that died halfway is the one failure mode on this path that silently returns a wrong answer,
 *    and MULTI does not prevent it under a connection pool.
 * 2.5 **Whole-store operations are batched.** Redis is single-threaded: however long a Lua script
 *    runs, the whole instance is blocked. `all()`, `purgeExpired()` and `clear()` scan every scope
 *    — unlike recall, which a scope bounds — so they slice by `batchSize`, one script per batch.
 *    **Atomicity is kept at the granularity that actually needs it**: a single entry's body plus
 *    its five indexes are always deleted within one script, so no orphaned index is left; across
 *    batches it is not atomic, and a failure partway leaves a partial deletion, which is
 *    acceptable for a maintenance operation.
 * 3. **Expiry cannot use Redis's native TTL.** The interface requires an expired entry to be
 *    invisible to the read path yet visible to `all()`, and `PEXPIREAT` really deletes, so `all()`
 *    would never see it again; besides, `now` is injected, and a fake clock cannot drive a native
 *    TTL at all. So `expires_at` is stored as an ordinary numeric attribute that participates in
 *    `FILTER`, and reaping goes through an explicit `purgeExpired()`.
 * 4. **`VSIM`'s score is not the cosine, it is `(1 + cosine) / 2`** (measured: orthogonal vectors
 *    give 0.5, and a cosine of -0.67466 gives 0.16268). `2 * score - 1` is what equals
 *    `VectorMath.cosine`, so the memory implementation and a real database rank recall the same
 *    way.
 *
 * **Two real precision differences, not bugs to fix**: vectors are stored as float32 (as in
 * pgvector), and a similarity comes back through Lua's `tostring` with 14 significant digits.
 * Both are far below any calibrated threshold's spacing, but **a sample sitting exactly on a
 * threshold can fall to the other side** — so calibrate and verify a threshold on the same
 * backend. lab/scripts/storeConformance.ts encodes it as a criterion.
 *
 * **Single-instance assumption**: the Lua scripts assemble secondary-index keys from an id on the
 * fly without declaring all of them in KEYS, which Redis Cluster rejects. Running on Cluster
 * would take a hash tag around the whole namespace.
 */
export interface RedisVectorSetCacheStoreOptions {
	readonly redis: RedisExecutor;
	/**
	 * The two vectors' dimension. **No default**: getting it wrong raises no error and only degrades
	 * recall quietly.
	 *
	 * `match` is validated (a vector set's dimension is fixed by its first `VADD`, so changing the
	 * encoder means changing the key); `answer` is only checked for validity here — an answer vector
	 * never enters the vector set, it sits in the entry hash and is read only for the entry rerank
	 * already selected, a point lookup rather than a search.
	 */
	readonly dimensions: { readonly match: number };
	/** Key prefix, `semcache` by default. Change it when the encoder changes, the equivalent of changing the table name on the pgvector side */
	readonly namespace?: string;
	/** Capacity eviction. Omitted means the sorted set is not maintained, at zero extra cost */
	readonly eviction?: EvictionConfig;
	/**
	 * Search approximately with HNSW. **Off by default**, meaning exact KNN within a scope (`VSIM ... TRUTH`).
	 *
	 * The reasoning matches the pgvector side: a scope usually holds a few hundred to a few thousand
	 * entries, an exact scan is fast enough, and the recall set is then the real recall set. With
	 * approximation on, a search carrying a `FILTER` may return fewer than `limit` rows.
	 */
	readonly ann?: boolean;
	/**
	 * How many entries per batch for whole-store operations (`all`, `purgeExpired`, `clear`). 500 by default.
	 *
	 * Larger saves round trips, smaller shortens how long one Lua script holds Redis — there is no
	 * universally optimal value between the two, since it depends on how long a block you can
	 * tolerate, so it is left as an option.
	 */
	readonly batchSize?: number;
	readonly now?: () => number;
}

/**
 * "Never expires" cannot be expressed in `VSIM`'s `FILTER`: a missing attribute makes the whole
 * expression false and the element is skipped outright. So a sentinel value is stored in the
 * attributes. **The entry hash is always the source of truth**; attributes only take part in
 * filtering, so the two cannot be ambiguous.
 */
const NEVER = Number.MAX_SAFE_INTEGER;

/** The order is `HMGET`'s return order, and changing one means changing the copy in the Lua alongside it */
const FIELDS = [
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
	// Accounting columns for lru/lfu. Appended at the end, leaving the preceding order untouched
	"last_used_at",
	"use_count",
] as const;

/** The literal list the Lua uses to assemble `HMGET` */
const LUA_FIELDS = FIELDS.map(f => `'${f}'`).join(", ");

/** The namespace is interpolated into keys and into Lua scripts, so validate it first */
function assertNamespace(namespace: string): void {
	if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(namespace)) {
		throw new Error(
			`Namespace ${JSON.stringify(namespace)} is not valid. Only letters, digits, underscores, dots and hyphens are allowed, and it cannot start with a hyphen or a dot.`,
		);
	}
}

function asArray(reply: unknown): Array<unknown> {
	return Array.isArray(reply) ? reply : [];
}

/**
 * A bulk string in a reply must already be a string. **A driver in Buffer mode blows up here, and
 * that is deliberate** — `String(buffer)` yields comma-separated bytes, turning vectors and JSON
 * into garbage without raising an error anywhere along the way.
 */
function asText(value: unknown): string {
	if (value === null || value === undefined || value === false) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
		return String(value);
	}
	throw new TypeError(
		`A Redis reply contained a non-string (${Object.prototype.toString.call(value)}). ` +
			"This store requires the driver to decode replies as strings — node-redis does so by default, " +
			"and ioredis needs call rather than callBuffer.",
	);
}

function parseNumberArray(value: string): Array<number> {
	if (value === "") {
		return [];
	}
	const parsed: unknown = JSON.parse(value);
	return Array.isArray(parsed) ? parsed.map(Number) : [];
}

function parseRecord(value: string): Record<string, string> {
	if (value === "") {
		return {};
	}
	const parsed: unknown = JSON.parse(value);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
		out[k] = String(v);
	}
	return out;
}

/** The 14 values `HMGET` returns, to an entry. Any missing field is treated as the entry not existing. */
function toEntry(values: ReadonlyArray<unknown>): CacheEntry | null {
	if (values.length < FIELDS.length) {
		return null;
	}
	const at = (name: (typeof FIELDS)[number]): string => asText(values[FIELDS.indexOf(name)]);
	if (values[0] === null || values[0] === undefined || values[0] === false) {
		return null;
	}
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
		createdAt: Number(at("created_at")),
		// An empty string means absent rather than 0 — createdAt does not need that distinction, expiresAt does
		expiresAt: expiresAt === "" ? null : Number(expiresAt),
		meta: meta === "" ? undefined : parseRecord(meta),
		// An empty string means never accounted for (always the case under fifo/rr), not 0
		lastUsedAt: at("last_used_at") === "" ? undefined : Number(at("last_used_at")),
		useCount: at("use_count") === "" ? undefined : Number(at("use_count")),
	};
}

/**
 * Write. **Check for a duplicate before writing**: the interface requires a duplicate id to throw,
 * and `VADD` overwrites an existing element, as does `HSET`, neither of them complaining.
 */
const SCRIPT_PUT = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 'DUP' end
local v = {KEYS[1], 'VALUES', tostring(#ARGV - 4)}
for i = 5, #ARGV do v[#v + 1] = ARGV[i] end
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
return 'OK'
`;

/**
 * Delete a batch of ids. All three entry points — `evict`, `clearScope`, `clear` — go through it;
 * they differ only in where the batch of ids comes from, so enumeration stays on the TS side
 * (which is what makes batching possible) and deletion stays here.
 *
 * **An entry's body plus its five indexes are always deleted within one script**: an orphaned
 * index left behind by a multi-structure write that died halfway is the one failure mode on this
 * path that silently returns a wrong answer.
 */
/**
 * An LFU score has to **hold both a count and a time**.
 *
 * A zset has only one double, and equal counts must fall back to LRU to break the tie — otherwise
 * entries on the same score can only be evicted by member lexicographic order, and a freshly
 * written entry gets deleted immediately because its id happens to sort early, disagreeing with
 * memory and pgvector (which is exactly how the conformance test caught it).
 *
 * The packing: `min(count, LFU_COUNT_CAP) * 2^41 + millisecond timestamp`.
 *   - 41 bits hold a millisecond timestamp through 2039 (2^41 is about 2.199e12, and the present
 *     is about 1.77e12)
 *   - a count capped at 1023 takes 10 bits, 51 in total, within a double's 53 significant bits
 *
 * Why the cap exists, and why all three backends must cap at the same value, is in `EvictionOrder.ts`.
 */
const LFU_TIME_BITS = 2 ** 41;

function lfuScore(useCount: number, lastUsedAt: number): number {
	return lfuCount(useCount) * LFU_TIME_BITS + lastUsedAt;
}

const SCRIPT_EVICT = `
local n = 0
for i = 2, #ARGV do
  local id = ARGV[i]
  local ek = ARGV[1] .. ':e:' .. id
  local m = redis.call('HMGET', ek, 'scope', 'match_hash')
  if m[1] then
    redis.call('VREM', KEYS[1], id)
    redis.call('DEL', ek)
    redis.call('ZREM', KEYS[2], id)
    redis.call('ZREM', ARGV[1] .. ':h:' .. m[1] .. ':' .. m[2], id)
    redis.call('SREM', ARGV[1] .. ':scope:' .. m[1], id)
    redis.call('ZREM', ARGV[1] .. ':rank:' .. m[1], id)
    n = n + 1
  end
end
return n
`;

/** Expiry reaping: deletes only the entries in this batch that are genuinely due. The ids arrive batched from the TS side. */
const SCRIPT_PURGE = `
local n = 0
for i = 3, #ARGV do
  local id = ARGV[i]
  local ek = ARGV[1] .. ':e:' .. id
  local exp = redis.call('HGET', ek, 'expires_at')
  if exp and exp ~= '' and tonumber(exp) <= tonumber(ARGV[2]) then
    local m = redis.call('HMGET', ek, 'scope', 'match_hash')
    if m[1] then
      redis.call('VREM', KEYS[1], id)
      redis.call('DEL', ek)
      redis.call('ZREM', KEYS[2], id)
      redis.call('ZREM', ARGV[1] .. ':h:' .. m[1] .. ':' .. m[2], id)
      redis.call('SREM', ARGV[1] .. ':scope:' .. m[1], id)
      redis.call('ZREM', ARGV[1] .. ':rank:' .. m[1], id)
      n = n + 1
    end
  end
end
return n
`;

/**
 * ② exact match. The zset is ordered by createdAt, so `ZREVRANGE` reproduces pgvector's
 * `ORDER BY created_at DESC, id DESC` — on equal scores a zset orders members
 * lexicographically, and reversed that is exactly id DESC. Takes the first **unexpired** one.
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

/**
 * `all()` wants the raw state, **including entries expired but not yet reaped**, in the same order
 * as pgvector's `ORDER BY created_at, id`. It takes only the `[ARGV[2], ARGV[3]]` slice at a time
 * — the whole set is assembled on the TS side.
 */
const SCRIPT_ALL = `
local ids = redis.call('ZRANGE', KEYS[1], tonumber(ARGV[2]), tonumber(ARGV[3]))
local out = {}
for _, id in ipairs(ids) do
  out[#out + 1] = redis.call('HMGET', ARGV[1] .. ':e:' .. id, ${LUA_FIELDS})
end
return out
`;

/**
 * ③ recall. **Scope and expiry are in the `FILTER`, not fetched back and filtered in the
 * application** — the interface requires that an expired entry is never returned even before it
 * has been reaped, and application-side filtering cannot deliver that under a `COUNT`: the limit
 * applies first, and expired entries crowd out the candidates that should have come back.
 *
 * Scores always come back through `tostring`: converting a Lua number to RESP truncates it to an
 * integer, so returning it directly turns every similarity into 0, and raises no error.
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
	const eviction = options.eviction;

	/**
	 * The sorted set's score is the **retention priority**: a higher score is kept longer, and what is deleted is the lowest.
	 *
	 * `fifo` uses the write time (written once and never touched), `lru` the last-used time
	 * (overwritten on touch), `lfu` the use count (incremented on touch). `rr` needs no order and
	 * samples the SET randomly, so it does not maintain this set.
	 */
	function keepScore(entry: CacheEntry): number {
		switch (eviction?.policy) {
			case "lru":
				return entry.lastUsedAt ?? entry.createdAt;
			case "lfu":
				// Never accounted for means just written, and counts as used once. See MemoryCacheStore.keepOrder for why
				return lfuScore(entry.useCount ?? 1, entry.lastUsedAt ?? entry.createdAt);
			default:
				return entry.createdAt;
		}
	}

	/**
	 * How many entries a scope holds right now. `rr` maintains no sorted set, so this counts the scope
	 * set instead. **What is counted is the members in the store, expired-but-unreaped included** —
	 * `trim` relies on `purgeExpiredIn` to erase the difference between the two.
	 */
	async function sizeOf(scope: string): Promise<number> {
		const rr = eviction?.policy === "rr";
		return Number(await redis.sendCommand(rr ? ["SCARD", keys.scope(scope)] : ["ZCARD", keys.rank(scope)]));
	}

	/**
	 * Reap the expired members in one scope and return how many.
	 *
	 * Called only under capacity pressure — it costs O(scope), and that path was going to sort and
	 * sample anyway. It runs the same script the whole-store `purgeExpired()` uses, so a body plus
	 * its five indexes are still deleted within one script and no orphaned index is left.
	 */
	async function purgeExpiredIn(scope: string): Promise<number> {
		const deadline = String(now());
		let removed = 0;
		for (const group of batches(await listSetIds(keys.scope(scope)))) {
			removed += Number(
				(await evalScript(SCRIPT_PURGE, [keys.vector, keys.all], [namespace, deadline, ...group])) ?? 0,
			);
		}
		return removed;
	}

	/**
	 * Squeeze one scope back to capacity and return how many were deleted. `rr` samples randomly, the rest use the sorted set.
	 *
	 * **Capacity counts live entries.** Over the limit, the members in this scope that have expired
	 * and merely have not been reaped by `purgeExpired()` yet are collected first, and only then is
	 * the limit rechecked. Live and dead were once not distinguished, so an expired member held a
	 * slot and displaced a live entry; and since the sorted set's score never looks at `expires_at`,
	 * that expired member could go on displacing several more as long as its `last_used_at` was
	 * recent enough. The memory and pgvector backends had the same defect and all three were fixed
	 * together — this is either done in all three backends or in none.
	 */
	async function trim(scope: string): Promise<number> {
		if (!eviction) {
			return 0;
		}
		if ((await sizeOf(scope)) <= eviction.capacity) {
			return 0;
		}
		const purged = await purgeExpiredIn(scope);
		const over = (await sizeOf(scope)) - eviction.capacity;
		if (over <= 0) {
			return purged;
		}
		let ids: Array<string>;
		if (eviction.policy === "rr") {
			// SRANDMEMBER with a negative count returns duplicates, so take a positive count and deduplicate
			const picked = (await redis.sendCommand(["SRANDMEMBER", keys.scope(scope), String(over)])) as Array<string>;
			ids = [...new Set(picked.map(String))];
		} else {
			// The batch with the lowest scores is the one to go
			const doomed = (await redis.sendCommand([
				"ZRANGE",
				keys.rank(scope),
				"0",
				String(over - 1),
			])) as Array<string>;
			ids = doomed.map(String);
		}
		return ids.length === 0 ? purged : purged + (await deleteIds(ids));
	}
	const { redis, dimensions } = options;
	const now = options.now ?? (() => Date.now());
	const batchSize = options.batchSize ?? 500;

	if (!Number.isInteger(batchSize) || batchSize <= 0) {
		throw new Error(`batchSize must be a positive integer, received ${String(options.batchSize)}`);
	}

	if (!Number.isInteger(dimensions.match) || dimensions.match <= 0) {
		throw new Error(`The match vector dimension must be a positive integer, received ${String(dimensions.match)}`);
	}

	/**
	 * Six structures. **Only the first comes from Redis; the other five are secondary indexes
	 * maintained here** — what a relational database gives for free becomes, here, a consistency
	 * obligation on the write path.
	 */
	const keys = {
		/** Vector set: elements are entry ids and attributes are `{scope, expires_at}`, for `VSIM`'s FILTER */
		vector: `${namespace}:v`,
		/** The entry body. The vector set holds only vectors; the answer and meta live here */
		entry: (id: string) => `${namespace}:e:${id}`,
		/** Every id, scored by createdAt. `all()`'s order is this set's */
		all: `${namespace}:all`,
		/** ② exact match's entry point, scored by createdAt, reproducing `ORDER BY created_at DESC` */
		byHash: (scope: string, hash: string) => `${namespace}:h:${scope}:${hash}`,
		/** `clearScope` has to enumerate by scope, which the vector set cannot do */
		scope: (scope: string) => `${namespace}:scope:${scope}`,
		/** The eviction sorted set. What its score means varies by policy, and it is maintained only when eviction is configured */
		rank: (scope: string) => `${namespace}:rank:${scope}`,
	};

	async function evalScript(
		script: string,
		keyList: ReadonlyArray<string>,
		argv: ReadonlyArray<string>,
	): Promise<unknown> {
		return redis.sendCommand(["EVAL", script, String(keyList.length), ...keyList, ...argv]);
	}

	function batches(ids: ReadonlyArray<string>): Array<Array<string>> {
		const out: Array<Array<string>> = [];
		for (let i = 0; i < ids.length; i += batchSize) {
			out.push(ids.slice(i, i + batchSize));
		}
		return out;
	}

	/** Every id, read out in batches. Deleting while reading shifts the zset's indexes, so reads and writes are split into two passes. */
	async function listAllIds(): Promise<Array<string>> {
		const out: Array<string> = [];
		for (let start = 0; ; start += batchSize) {
			const page = asArray(
				await redis.sendCommand(["ZRANGE", keys.all, String(start), String(start + batchSize - 1)]),
			);
			for (const id of page) {
				out.push(asText(id));
			}
			if (page.length < batchSize) {
				return out;
			}
		}
	}

	/** The ids under one scope or one source. A single set's size is bounded by the scope, so one read suffices. */
	async function listSetIds(setKey: string): Promise<Array<string>> {
		return asArray(await redis.sendCommand(["SMEMBERS", setKey])).map(asText);
	}

	/** The four deletion entry points differ only in where the batch of ids comes from; deletion itself is batched, one atomic script per batch */
	async function deleteIds(ids: ReadonlyArray<string>): Promise<number> {
		let removed = 0;
		for (const group of batches(ids)) {
			const done = await evalScript(SCRIPT_EVICT, [keys.vector, keys.all], [namespace, ...group]);
			removed += Number(done ?? 0);
		}
		return removed;
	}

	/**
	 * Vector components are always converted to strings before being handed over.
	 *
	 * **A non-finite component throws rather than being stored as 0.** Storing 0 was once an attempt
	 * at not letting one dirty vector ruin a whole write, but the same input is a hard error on
	 * pgvector and stored verbatim in memory — three backends, three symptoms, and this is the first
	 * place a broken encoder hits. The reasoning, and where it was unified, are in
	 * `assertFiniteVector`. Note that the `JSON.stringify(matchVector)` copy in the hash writes NaN
	 * as `null` and reads back as 0: there is more than one silent path here, which is why it is
	 * stopped once at the entrance.
	 */
	function vectorArgs(name: string, vector: ReadonlyArray<number>): Array<string> {
		assertFiniteVector(name, vector);
		return vector.map(String);
	}

	return {
		/**
		 * Idempotent, so it can sit directly on the startup path.
		 *
		 * There is no table to create here — a vector set comes into existence at its first `VADD`, and
		 * its dimension is fixed then. So what this does is two checks: whether the module is present,
		 * and whether an existing vector set's dimension matches.
		 */
		async ensureSchema(): Promise<void> {
			try {
				await redis.sendCommand(["VCARD", keys.vector]);
			} catch (err) {
				const message = String(err);
				if (/unknown command/iu.test(message)) {
					throw new Error(
						"This Redis has no vectorset (VADD/VSIM). Redis 8 or newer is required — it ships in the " +
							`core, and MODULE LIST shows whether vectorset is there. Original error: ${message}`,
					);
				}
				throw err;
			}

			const info = asArray(await redis.sendCommand(["VINFO", keys.vector]));
			for (let i = 0; i + 1 < info.length; i += 2) {
				if (asText(info[i]) !== "vector-dim") {
					continue;
				}
				const actual = Number(asText(info[i + 1]));
				if (Number.isFinite(actual) && actual !== dimensions.match) {
					throw new Error(
						`${keys.vector} has ${actual} dimensions, but the current encoder produces ${dimensions.match}. ` +
							"Changing the encoder means changing the key — delete the old one or pick another with " +
							"the namespace option; mixing them piles entries from two vector spaces together.",
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
			if (entry === null) {
				return null;
			}
			// The read path cannot see expired entries. Use all() for the raw state
			return entry.expiresAt === null || entry.expiresAt > now() ? entry : null;
		},

		async searchNearest(scope, vector, limit) {
			// A scope may contain quotes or backslashes, so leave the escaping to JSON.stringify rather than assembling it by hand
			const filter = `.scope == ${JSON.stringify(scope)} and .expires_at > ${now()}`;
			const hits = asArray(
				await evalScript(
					SCRIPT_SEARCH,
					[keys.vector],
					[
						namespace,
						String(limit),
						filter,
						options.ann ? "" : "TRUTH",
						...vectorArgs("query vector", vector),
					],
				),
			);
			const out: Array<Candidate> = [];
			for (const hit of hits) {
				const row = asArray(hit);
				const entry = toEntry(row);
				if (entry === null) {
					continue;
				}
				// VSIM gives (1 + cosine) / 2, and recovering the cosine is what equals VectorMath.cosine
				const score = Number(asText(row[FIELDS.length]));
				const similarity = Number.isFinite(score) ? 2 * score - 1 : 0;
				out.push({ entry, similarity });
			}
			return out;
		},

		async put(entry) {
			const fields: Array<string> = [
				"id",
				entry.id,
				"scope",
				entry.scope,
				"match_text",
				entry.matchText,
				"match_hash",
				entry.matchHash,
				"match_vector",
				JSON.stringify(entry.matchVector),
				"kind",
				entry.kind,
				"answer",
				entry.answer,
				"plan",
				JSON.stringify(entry.plan),
				"created_at",
				String(entry.createdAt),
				// An empty string means never expires. Storing 0 would turn it into long since expired
				"expires_at",
				entry.expiresAt === null ? "" : String(entry.expiresAt),
				"meta",
				entry.meta === undefined ? "" : JSON.stringify(entry.meta),
				// Accounting columns for lru/lfu. An empty string means never accounted for, and reads back as undefined
				"last_used_at",
				entry.lastUsedAt === undefined ? "" : String(entry.lastUsedAt),
				"use_count",
				entry.useCount === undefined ? "" : String(entry.useCount),
			];
			/**
			 * **"Never expires" is `NEVER` in the attributes and an empty string in the hash — the two
			 *
			 * representations differ deliberately.** `VSIM`'s FILTER reads only attributes, and the expression
			 * is `.expires_at > <now>`: with an empty string there, a string and a number do not compare and
			 * every non-expiring entry becomes completely invisible to ③. On the hash side a `0` would read
			 * as long since expired, so it can only be the empty string. Look at one side before changing
			 * the other.
			 */
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
					...vectorArgs("matchVector ", entry.matchVector),
				],
			);
			if (asText(done) === "DUP") {
				throw new Error(
					`Duplicate cache entry id: ${entry.id}. Ids are generated by the library, so a duplicate can only be a generator collision.`,
				);
			}
			if (eviction) {
				// rr needs no sorted set — it samples the scope's SET randomly
				if (eviction.policy !== "rr") {
					await redis.sendCommand(["ZADD", keys.rank(entry.scope), String(keepScore(entry)), entry.id]);
				}
				await trim(entry.scope);
			}
		},

		async evict(id) {
			await deleteIds([id]);
		},

		async touch(id) {
			// fifo/rr need no accounting — this does not even make a round trip
			if (eviction?.policy !== "lru" && eviction?.policy !== "lfu") {
				return;
			}
			const ek = keys.entry(id);
			const got = (await redis.sendCommand(["HMGET", ek, "scope", "use_count"])) as Array<string | null>;
			const scope = got[0];
			if (scope === null || scope === undefined) {
				return; // It may have just been evicted concurrently, so this returns silently
			}
			/**
			 * Base 1: the retention priority counts never-accounted-for as one use, and starting from 0 would leave a first reuse without a priority bump.
			 *
			 * **Never accounted for is the empty string in the entry hash, not null** — `put` writes
			 * `use_count = ""` (see the write above). So `?? 1` does not catch it: `Number("")` is 0, and
			 * every entry on the Redis side then counts one lower than on memory and pgvector (which use
			 * `?? 1` and `COALESCE(use_count, 1)` respectively). Under `lfu` that difference changes
			 * lfuScore's packed value and so the eviction order on equal scores — which is exactly what the
			 * conformance script's two "e0 accounting" lines exposed.
			 */
			const recorded = got[1];
			const previous = recorded === null || recorded === undefined || recorded === "" ? 1 : Number(recorded);
			const next = previous + 1;
			const stamp = now();
			await redis.sendCommand(["HSET", ek, "last_used_at", String(stamp), "use_count", String(next)]);
			await redis.sendCommand([
				"ZADD",
				keys.rank(String(scope)),
				String(eviction.policy === "lfu" ? lfuScore(next, stamp) : stamp),
				id,
			]);
		},

		async evictOverCapacity(scope) {
			return trim(scope);
		},

		async purgeExpired() {
			const deadline = String(now());
			let removed = 0;
			for (const group of batches(await listAllIds())) {
				const done = await evalScript(SCRIPT_PURGE, [keys.vector, keys.all], [namespace, deadline, ...group]);
				removed += Number(done ?? 0);
			}
			return removed;
		},

		async clearScope(scope) {
			return deleteIds(await listSetIds(keys.scope(scope)));
		},

		async clear() {
			await deleteIds(await listAllIds());
			// Deleting entry by entry should already have made these two keys disappear; this is a fallback, so no empty shell is left to block the dimension check
			await redis.sendCommand(["DEL", keys.vector, keys.all]);
		},

		async all() {
			// Like the memory implementation, this **does not filter expired entries** — it is the raw state, for UIs and assertions
			const out: Array<CacheEntry> = [];
			for (let start = 0; ; start += batchSize) {
				const rows = asArray(
					await evalScript(SCRIPT_ALL, [keys.all], [namespace, String(start), String(start + batchSize - 1)]),
				);
				for (const row of rows) {
					const entry = toEntry(asArray(row));
					if (entry !== null) {
						out.push(entry);
					}
				}
				if (rows.length < batchSize) {
					return out;
				}
			}
		},
	};
}
