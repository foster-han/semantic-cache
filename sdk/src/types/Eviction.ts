/**
 * Capacity eviction policy.
 *
 * **The four differ substantially in cost, and the difference is whether the read path has to
 * write.** This is not a matter of taste:
 *
 * | Policy | Ordered by | Bookkeeping on a hit? |
 * |---|---|---|
 * | `fifo` | Write time (already stored) | **No** |
 * | `rr` | Random | **No** |
 * | `lru` | Last-used time | **Yes** — one UPDATE per hit |
 * | `lfu` | Use count | **Yes** — one increment per hit |
 *
 * A semantic cache's hit path is otherwise "one vector search plus a few comparisons"; `lru` and
 * `lfu` add a write to it. More hits, more writes — and plenty of hits is precisely when this
 * thing is working. Hence `fifo` as the default: it orders on the `createdAt` already stored, at
 * no extra cost, and it is sufficient for the dominant failure mode of a semantic cache, which is
 * the question distribution drifting over time.
 *
 * Choosing `lru`/`lfu` is explicitly accepting that write. `touch()` is a genuine no-op under
 * `fifo`/`rr` (it issues no request), so callers can call it unconditionally and leave the policy
 * knowledge in the store.
 */
export type EvictionPolicy = "fifo" | "rr" | "lru" | "lfu";

export interface EvictionConfig {
	readonly policy: EvictionPolicy;
	/**
	 * How many entries to keep **per scope**, not across the whole store.
	 *
	 * Recall is scope-local (gate ③'s pre-filter), so "too many" is a scope-local notion: one
	 * course accumulating a hundred thousand entries slows down its own KNN and has nothing to do
	 * with any other course. A store-wide cap would let a busy scope evict every entry belonging to
	 * a quiet one — among the hardest classes of bug to track down in a multi-tenant system.
	 */
	/**
	 * **A soft limit, not a hard constraint.** Writing and evicting are two statements with no
	 * enclosing transaction, so concurrent writers can briefly push the count above it (the next
	 * `put` or `evictOverCapacity` brings it back down). Treating it as a hard constraint, for
	 * quota billing say, requires a guarantee of your own above this layer.
	 *
	 * **It counts live entries.** Over the limit, rows in this scope that have already expired but
	 * have not yet been cleaned up by `purgeExpired()` are collected first, and only then does
	 * policy eviction run — otherwise an expired row, long invisible on the read path, occupies a
	 * slot and pushes out a live entry. `lru`/`lfu` ordering does not look at `expires_at` at all,
	 * so such a row need only have been "used" recently to keep pushing out several more. All three
	 * backends share this semantics.
	 */
	readonly capacity: number;
}
