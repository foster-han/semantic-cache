import { lfuCount } from "./EvictionOrder.ts";
import type { CacheEntry, Candidate, InspectableCacheStore } from "./types/CacheStore.ts";
import type { EvictionConfig } from "./types/Eviction.ts";
import { assertFiniteVector, cosine } from "./VectorMath.ts";

/**
 * The in-memory implementation. For unit tests, offline calibration, and the local lab.
 *
 * Production swaps in `createPgVectorCacheStore` and `SemanticCache` needs no change at all — the
 * decision logic is storage-independent. Recall ordering matches bit for bit too: pgvector's
 * `1 - (v <=> q)` is exactly the `cosine` used here.
 *
 * `all()` / `clear()` are async even though in memory they could be synchronous — so that moving
 * from memory to pgvector does not make callers rewrite their awaits.
 */
export function createMemoryCacheStore(options?: {
	now?: (() => number) | undefined;
	/** Capacity eviction. Omit it and nothing is evicted — only TTL and explicit invalidation apply. */
	eviction?: EvictionConfig;
}): InspectableCacheStore {
	const now = options?.now ?? (() => Date.now());
	const eviction = options?.eviction;
	let entries: Array<CacheEntry> = [];

	/**
	 * **Retention priority** during eviction: earlier entries are kept, and anything past capacity
	 * is deleted from the tail.
	 *
	 * All three deterministic policies carry id as a secondary key — without one, "which entry gets
	 * deleted" among same-millisecond writes or equal use counts becomes an implementation detail,
	 * and the three backends answer differently.
	 *
	 * **`rr` does not use this comparator**; it uses `sample()`'s uniform draw. The reasons for the
	 * count cap and for "no bookkeeping counts as one" are in `EvictionOrder.ts` — all three
	 * backends must share that file.
	 *
	 * LFU here only solves half the problem, the half where new entries cannot get in. "A
	 * frequently used old entry crowding out new ones" is inherent to LFU and needs decay to fix,
	 * which is not done here.
	 */
	function keepOrder(a: CacheEntry, b: CacheEntry): number {
		switch (eviction?.policy) {
			case "lru": {
				const ua = a.lastUsedAt ?? a.createdAt;
				const ub = b.lastUsedAt ?? b.createdAt;
				return ub - ua || (a.id < b.id ? 1 : -1);
			}
			case "lfu": {
				const ca = lfuCount(a.useCount);
				const cb = lfuCount(b.useCount);
				if (ca !== cb) {
					return cb - ca;
				}
				// Equal counts fall back to LRU — pure LFU lets an old entry that accumulated a high
				// count early sit there forever.
				const ua = a.lastUsedAt ?? a.createdAt;
				const ub = b.lastUsedAt ?? b.createdAt;
				return ub - ua || (a.id < b.id ? 1 : -1);
			}
			default: // fifo: keep the newest (rr goes through sample() and never reaches here)
				return b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);
		}
	}

	/**
	 * Draw `k` entries uniformly from `pool`.
	 *
	 * **`sort(() => Math.random() - 0.5)` will not do.** That comparator is neither reflexive nor
	 * transitive, so it is not a uniform shuffle: the permutation `Array.prototype.sort` produces on
	 * such input depends on its internal merge/insertion path and is markedly biased toward the
	 * original order — which quietly turns `rr` into "biased toward evicting what was written
	 * first", colliding with `fifo` while advertising randomness. A partial Fisher–Yates shuffles
	 * only the first k, in O(k).
	 */
	function sample(pool: ReadonlyArray<CacheEntry>, k: number): Array<CacheEntry> {
		const copy = [...pool];
		const out: Array<CacheEntry> = [];
		for (let i = 0; i < k && i < copy.length; i++) {
			const j = i + Math.floor(Math.random() * (copy.length - i));
			const swap = copy[i];
			copy[i] = copy[j];
			copy[j] = swap;
			out.push(copy[i]);
		}
		return out;
	}

	/**
	 * Bring one scope back to capacity, returning how many were deleted. **`put` and
	 * `evictOverCapacity` share this one function** — the two used to be duplicated verbatim (the
	 * pgvector backend had already been merged once for the same reason).
	 *
	 * **Expired-but-uncleaned rows go first, and only then does policy eviction run.** Capacity
	 * counts live entries: it used to count every row in the array, so a row that had expired and
	 * merely had not been collected by `purgeExpired` occupied a slot and pushed out a live entry —
	 * and since retention priority does not look at expiry at all, that expired row need only have a
	 * recent enough `lastUsedAt` to keep pushing out several more. pgvector and Redis had the same
	 * defect; all three were fixed together.
	 *
	 * Expiry is only scanned when over capacity — no extra cost below the limit, and this path has
	 * to sort anyway.
	 */
	function trim(scope: string): number {
		const ev = eviction;
		if (!ev) {
			return 0;
		}
		const scoped = entries.filter(e => e.scope === scope);
		if (scoped.length <= ev.capacity) {
			return 0;
		}
		const t = now();
		const doomed = new Set(scoped.filter(e => e.expiresAt !== null && e.expiresAt <= t).map(e => e.id));
		const alive = scoped.filter(e => !doomed.has(e.id));
		const over = alive.length - ev.capacity;
		if (over > 0) {
			const victims = ev.policy === "rr" ? sample(alive, over) : [...alive].sort(keepOrder).slice(ev.capacity);
			for (const e of victims) {
				doomed.add(e.id);
			}
		}
		entries = entries.filter(e => !doomed.has(e.id));
		return doomed.size;
	}

	function live(): Array<CacheEntry> {
		const t = now();
		return entries.filter(e => e.expiresAt === null || e.expiresAt > t);
	}

	return {
		getByHash(scope, matchHash) {
			// Return the newest. This used to use find() (the first inserted), the exact opposite of
			// pgvector's ORDER BY created_at DESC — so once concurrency produced duplicate entries,
			// switching storage backends made gate ② hit a different answer.
			const matches = live().filter(e => e.scope === scope && e.matchHash === matchHash);
			if (matches.length === 0) {
				return Promise.resolve(null);
			}
			return Promise.resolve(
				matches.reduce((best, e) =>
					e.createdAt > best.createdAt || (e.createdAt === best.createdAt && e.id > best.id) ? e : best,
				),
			);
		},
		getById(id) {
			return Promise.resolve(live().find(e => e.id === id) ?? null);
		},
		// `assertFiniteVector` throws synchronously while the interface returns a Promise, so `async`
		// is what converts that throw into a rejection. Dropping it would make the error escape
		// synchronously at the call site instead.
		// biome-ignore lint/suspicious/useAwait: async is load-bearing, see above
		async searchNearest(scope, vector, limit) {
			// All three backends throw on a non-finite component (see assertFiniteVector) — not
			// throwing here means gate ③ always lets everything through.
			assertFiniteVector("query vector", vector);
			const scoped = live().filter(e => e.scope === scope);
			const ranked: Array<Candidate> = scoped.map(entry => ({
				entry,
				similarity: cosine(vector, entry.matchVector),
			}));
			ranked.sort((a, b) => b.similarity - a.similarity);
			return ranked.slice(0, limit);
		},
		// Throws on a duplicate id and on a non-finite vector; see `searchNearest` above for why
		// `async` is load-bearing here.
		// biome-ignore lint/suspicious/useAwait: async is load-bearing, see above
		async put(entry) {
			// The interface requires a duplicate id to throw. This used to push unconditionally, so
			// one id-collision bug showed up in the memory backend as "both rows present, the later
			// write is unreachable" and in pgvector as "the later write is silently dropped" — one bug
			// with two symptoms is the hardest kind to diagnose.
			if (entries.some(e => e.id === entry.id)) {
				throw new Error(
					`Duplicate cache entry id: ${entry.id}. Ids are generated by the library, so a duplicate can only be a generator collision.`,
				);
			}
			// pgvector checks the same thing in toVectorLiteral, Redis in vectorArgs.
			assertFiniteVector("matchVector", entry.matchVector);
			entries.push(entry);
			trim(entry.scope);
		},
		evict(id) {
			entries = entries.filter(e => e.id !== id);
			return Promise.resolve();
		},
		touch(id) {
			// fifo/rr need no bookkeeping — a genuine no-op that does not even look the entry up.
			if (eviction?.policy !== "lru" && eviction?.policy !== "lfu") {
				return Promise.resolve();
			}
			const i = entries.findIndex(e => e.id === id);
			if (i < 0) {
				// May have just been evicted concurrently; return silently.
				return Promise.resolve();
			}
			const e = entries[i];

			// The base is 1, not 0 — retention priority treats "never bookkept" as 1 as well (a write
			// is itself a use), and starting from 0 would make the first reuse raise priority not at
			// all, breaking one rung off the ladder.
			entries[i] = { ...e, lastUsedAt: now(), useCount: (e.useCount ?? 1) + 1 };
			return Promise.resolve();
		},

		evictOverCapacity(scope) {
			return Promise.resolve(trim(scope));
		},

		purgeExpired() {
			const t = now();
			const before = entries.length;
			entries = entries.filter(e => e.expiresAt === null || e.expiresAt > t);
			return Promise.resolve(before - entries.length);
		},
		clearScope(scope) {
			const before = entries.length;
			entries = entries.filter(e => e.scope !== scope);
			return Promise.resolve(before - entries.length);
		},
		all() {
			// Return a copy: handing out the internal array would let a caller's reference change as
			// later writes land. The ordering is required by the contract (ascending createdAt, ties
			// by id) — insertion order coincides with it only when entries happen to be written in
			// time order, and that coincidence once hid a divergence between a real database and
			// memory.
			return Promise.resolve(
				[...entries].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
			);
		},
		clear() {
			entries = [];
			return Promise.resolve();
		},
	};
}
