import type { CacheResult, GateId } from "./types/Pipeline.ts";

/**
 * Metrics accumulator. **Feed it `CacheResult`s; it touches no clock, no network, no storage.**
 *
 * It covers what the Redis LangCache dashboard reports (requests / hits / misses, hit rate,
 * latency, token savings, per-segment hit rate) plus what that dashboard cannot: how many each of
 * the five gates stopped, and which gate ordered an eviction.
 *
 * **Precision and true-negative rate are deliberately not computed.** Both need labels — you have
 * to know whether the reused answer was correct — and production does not have that information.
 * The LangCache dashboard omits them too, filling the gap with sampled LLM-as-a-judge. For those
 * two numbers, use `Evaluation.ts` with a labelled set, or sample production traffic for human
 * review. Putting a number that requires labels on a dashboard that only counts is an invitation to
 * misread it.
 */
export interface MetricsSnapshot {
	/** Every request fed in, including the policy bypasses. */
	readonly requests: number;
	/**
	 * **Requests that actually consulted the cache** = `requests − byOutcome.bypassed`.
	 *
	 * This, not `requests`, is the hit rate's denominator. A bypassed request ran no gate at all, and
	 * counting it in the denominator makes a deployment whose policy bypasses most of its traffic
	 * look on the dashboard like "a cache that hits nothing" — which is exactly the misreading the
	 * `bypassedByReason` column was added to prevent, except that it was prevented in the breakdown
	 * and not in the totals. The three numbers reconcile:
	 * `requests = hits + misses + byOutcome.bypassed`.
	 */
	readonly attempted: number;
	/** Reused the cache (exact hits and semantic reuse alike). */
	readonly hits: number;
	/** **Consulted and missed** = `attempted − hits`. Bypassed requests are not included. */
	readonly misses: number;
	/** hits / attempted. Zero rather than NaN when attempted is 0. */
	readonly hitRate: number;
	readonly byOutcome: Readonly<Record<"exact" | "reuse" | "generated" | "bypassed", number>>;
	/**
	 * Policy bypasses, **grouped by reason**.
	 *
	 * `missedAtGate` answers "it was consulted and not used — which gate stopped it"; this answers
	 * "it was never consulted — which rule said so". Without it, a misconfigured policy (some
	 * upstream signal stuck on) shows up only as a falling hit rate with no way to find the cause on
	 * the dashboard — the disease behind silent no-ops in mainstream frameworks.
	 */
	readonly bypassedByReason: Readonly<Record<string, number>>;
	/**
	 * On a miss, **which gate stopped it**. This is what a single-threshold cache like LangCache
	 * cannot give: it has only hit/miss, while semcache can say whether the question side did not
	 * match (③) or the reranker overruled it (④) — two misses calling for different responses.
	 *
	 * There is no eviction counter beside it. ⑤ was the only gate that deleted on a read, and with
	 * it gone the count would be permanently zero; the reasoning is on `GateTrace`.
	 */
	readonly missedAtGate: Readonly<Partial<Record<GateId, number>>>;
	/**
	 * Latency percentiles. **Hits and misses are kept apart** — a blended average is flattened by
	 * the few milliseconds a hit costs, hiding the generation a miss has to pay for.
	 *
	 * **Bypasses form their own bucket**, as in `byOutcome`. They are the "no cache at all" baseline:
	 * a miss pays recall plus retrieval plus support scoring plus generation, while a bypass pays
	 * only generation. Folding them into `miss` under-reports miss latency, and that number is
	 * exactly what the cache layer's added overhead is computed from.
	 */
	readonly latencyMs: {
		readonly hit: LatencyStats;
		readonly miss: LatencyStats;
		readonly bypassed: LatencyStats;
	};
	/**
	 * **Generations saved outright** = `exact + reuse`. Converted to money only when
	 * `costPerGeneration` is supplied — unit price is the caller's business and the library does not
	 * guess it.
	 */
	readonly saved: { readonly generations: number; readonly cost: number | null };
	/**
	 * Per-segment hit rate, with segments supplied by the caller (scope, tenant, topic, …). The
	 * counterpart of LangCache's hit rate by category. The denominator is "actually consulted"
	 * (`requests − bypassed`) as it is globally, or the two hit rates would contradict each other.
	 */
	readonly bySegment: ReadonlyArray<{
		readonly segment: string;
		readonly requests: number;
		readonly bypassed: number;
		readonly hits: number;
		readonly hitRate: number;
	}>;
	/**
	 * The shadow-mode ledger. Meaningful only under `shadow: true`, where every request really
	 * generates and this records whether it **would have** been reused.
	 */
	readonly shadow: { readonly requests: number; readonly wouldReuse: number; readonly wouldReuseRate: number };
}

export interface LatencyStats {
	readonly count: number;
	readonly p50: number;
	readonly p95: number;
	readonly max: number;
}

export interface MetricsOptions {
	/** The cost of one generation, used to convert "N generations saved" into money. Omitted, only counts are reported. */
	readonly costPerGeneration?: number;
	/**
	 * How many samples to keep per bucket (beyond that, the ring overwrites). Default 2048 — a
	 * dashboard wants percentiles, not every sample, and an unbounded array is a memory leak in a
	 * long-running process.
	 *
	 * The three latency buckets count independently: hit, miss, and policy bypass.
	 */
	readonly latencySamples?: number;
	/**
	 * How many **real** keys `bypassedByReason` and `bySegment` each keep at most. Default 256, with
	 * the rest folded into `"(other)"` — so a snapshot holds at most `maxDistinctKeys + 1` entries.
	 *
	 * No count is lost: overflowing requests go into the "other" bucket and the totals still
	 * reconcile.
	 *
	 * Neither map's keys are fully under the library's control: segment keys come from the caller,
	 * and a bypass reason embeds the call type taken from `context` — unbounded cardinality. Latency
	 * samples were already protected against the same thing (a bounded ring); these two were not,
	 * and in a long-running process one misspelled `callType` was enough to blow them up.
	 */
	readonly maxDistinctKeys?: number;
}

export interface MetricsRecording {
	readonly result: CacheResult;
	/** Wall-clock time for this resolve. Omitted, it does not enter the latency statistics. */
	readonly ms?: number;
	/** Segment key. Omitted, it does not enter the per-segment statistics. */
	readonly segment?: string;
}

export interface Metrics {
	record(entry: MetricsRecording): void;
	snapshot(): MetricsSnapshot;
	reset(): void;
}

const HIT_OUTCOMES = new Set(["exact", "reuse"]);

function percentile(sorted: ReadonlyArray<number>, q: number): number {
	if (sorted.length === 0) {
		return 0;
	}
	// Nearest rank: no interpolation on small samples, so no latency is ever reported that did not
	// actually occur.
	const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
	return sorted[rank];
}

function stats(samples: ReadonlyArray<number>): LatencyStats {
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		count: sorted.length,
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
	};
}

export function createMetrics(options?: MetricsOptions): Metrics {
	const cap = options?.latencySamples ?? 2048;
	const cost = options?.costPerGeneration;

	let requests = 0;
	let hits = 0;
	const byOutcome = { exact: 0, reuse: 0, generated: 0, bypassed: 0 };
	const bypassedByReason = new Map<string, number>();
	const maxKeys = options?.maxDistinctKeys ?? 256;
	const OVERFLOW = "(other)";
	/** Once full, new keys go into "other" — keys already present keep accumulating, so no existing statistic is lost. */
	function bump<T>(map: Map<string, T>, key: string, next: (previous: T | undefined) => T): void {
		const slot = map.has(key) || map.size < maxKeys ? key : OVERFLOW;
		map.set(slot, next(map.get(slot)));
	}
	let shadowRequests = 0;
	let shadowWouldReuse = 0;
	const missedAtGate = new Map<GateId, number>();
	let hitLatency: Array<number> = [];
	let missLatency: Array<number> = [];
	let bypassLatency: Array<number> = [];
	const segments = new Map<string, { requests: number; bypassed: number; hits: number }>();

	/** Ring replacement: past the limit the oldest sample is overwritten, keeping memory bounded without discarding the distribution wholesale. */
	let hitCursor = 0;
	let missCursor = 0;
	let bypassCursor = 0;
	function push(buf: Array<number>, cursor: number, ms: number): number {
		if (buf.length < cap) {
			buf.push(ms);
			return cursor;
		}
		buf[cursor] = ms;
		return (cursor + 1) % cap;
	}

	return {
		record({ result, ms, segment }) {
			requests += 1;
			const hit = HIT_OUTCOMES.has(result.outcome);
			const bypassed = result.outcome === "bypassed";
			if (hit) {
				hits += 1;
			}
			byOutcome[result.outcome] += 1;
			if (bypassed) {
				bump(bypassedByReason, result.bypassReason ?? "(no reason given)", previous => (previous ?? 0) + 1);
			}

			if (!hit && result.exitedAt !== null) {
				missedAtGate.set(result.exitedAt, (missedAtGate.get(result.exitedAt) ?? 0) + 1);
			}

			if (result.wouldReuse !== null) {
				shadowRequests += 1;
				if (result.wouldReuse) {
					shadowWouldReuse += 1;
				}
			}

			if (ms !== undefined) {
				// Three buckets, matching byOutcome: a bypass never consulted the cache, and folding it
				// into miss under-reports what a miss costs.
				if (hit) {
					hitCursor = push(hitLatency, hitCursor, ms);
				} else if (bypassed) {
					bypassCursor = push(bypassLatency, bypassCursor, ms);
				} else {
					missCursor = push(missLatency, missCursor, ms);
				}
			}
			if (segment !== undefined) {
				bump(segments, segment, previous => {
					const bucket = previous ?? { requests: 0, bypassed: 0, hits: 0 };
					bucket.requests += 1;
					if (bypassed) {
						bucket.bypassed += 1;
					}
					if (hit) {
						bucket.hits += 1;
					}
					return bucket;
				});
			}
		},

		snapshot() {
			const gates: Partial<Record<GateId, number>> = {};
			for (const [gate, n] of [...missedAtGate.entries()].sort((a, b) => a[0] - b[0])) {
				gates[gate] = n;
			}
			// A bypassed request ran no gate at all, so it does not belong in the hit rate's denominator
			// (see attempted).
			const attempted = requests - byOutcome.bypassed;
			return {
				requests,
				attempted,
				hits,
				misses: attempted - hits,
				hitRate: attempted === 0 ? 0 : hits / attempted,
				byOutcome: { ...byOutcome },
				shadow: {
					requests: shadowRequests,
					wouldReuse: shadowWouldReuse,
					wouldReuseRate: shadowRequests === 0 ? 0 : shadowWouldReuse / shadowRequests,
				},
				bypassedByReason: Object.fromEntries([...bypassedByReason.entries()].sort((a, b) => b[1] - a[1])),
				missedAtGate: gates,
				latencyMs: { hit: stats(hitLatency), miss: stats(missLatency), bypassed: stats(bypassLatency) },
				saved: (() => {
					const fully = byOutcome.exact + byOutcome.reuse;
					return { generations: fully, cost: cost === undefined ? null : fully * cost };
				})(),
				bySegment: [...segments.entries()]
					.map(([segment, b]) => {
						const tried = b.requests - b.bypassed;
						return {
							segment,
							requests: b.requests,
							bypassed: b.bypassed,
							hits: b.hits,
							hitRate: tried === 0 ? 0 : b.hits / tried,
						};
					})
					.sort((a, b) => b.requests - a.requests),
			};
		},

		reset() {
			requests = 0;
			hits = 0;
			byOutcome.exact = 0;
			byOutcome.reuse = 0;
			byOutcome.generated = 0;
			byOutcome.bypassed = 0;
			bypassedByReason.clear();
			shadowRequests = 0;
			shadowWouldReuse = 0;
			missedAtGate.clear();
			hitLatency = [];
			missLatency = [];
			bypassLatency = [];
			hitCursor = 0;
			missCursor = 0;
			bypassCursor = 0;
			segments.clear();
		},
	};
}
