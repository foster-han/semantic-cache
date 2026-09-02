/**
 * Eviction-ordering details shared by the three backends.
 *
 * Retention priority itself is written once per backend (SQL's `ORDER BY`, a zset score, an array
 * comparator — the shapes are too far apart, and forcing an abstraction would make all of them
 * awkward), but **the parameters must be the same**, or the hard requirement that the three
 * backends agree breaks silently at some boundary — and that kind of break is only visible when a
 * conformance test happens to sweep that exact range.
 */

/**
 * Cap on `lfu`'s use count.
 *
 * **The cap is deliberate, not a precision compromise.** Redis's own LFU uses an 8-bit logarithmic
 * counter for the same reason: an uncapped counter lets an old entry that accumulated a high count
 * early sit there forever. The Redis backend has an additional reason — it packs count and time
 * into a single zset double, and 10 bits of count plus a 41-bit millisecond timestamp is 51 bits,
 * just inside a double's 53 significant bits.
 *
 * **But the cap has to apply to all three backends at once.** Previously only Redis capped, while
 * in-memory and pgvector used the raw `use_count`: given entries with counts 1500 and 1100,
 * in-memory and pgvector keep the 1500 one, while Redis sees a tie and falls back to breaking it by
 * time — a genuine cross-backend semantic divergence, which only shows up past 1023 uses, so the
 * conformance tests never hit it.
 */
export const LFU_COUNT_CAP = 1023;

/**
 * The use count `lfu` orders on.
 *
 * **An entry with no bookkeeping counts as "used once", not zero.** The write itself is a use;
 * counted as zero it sorts behind every entry that has been touched, so when a scope is full **a
 * freshly written entry is deleted immediately by the eviction its own write triggered** — the
 * `entryId` returned by `resolve` points at a record that no longer exists, and that question can
 * never establish itself in this scope. Counted as one, it ties with old entries used exactly once,
 * and LRU breaks the tie in the newer entry's favour.
 */
export function lfuCount(useCount: number | undefined): number {
	return Math.min(useCount ?? 1, LFU_COUNT_CAP);
}
