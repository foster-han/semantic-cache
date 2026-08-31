import type { CacheResult, GateId } from "./types/Pipeline.ts";

/**
 * 指标累加器。**喂 `CacheResult` 进去，不碰时钟、不碰网络、不碰存储。**
 *
 * 对齐 Redis LangCache 看板给的那一组（请求/命中/未命中、命中率、延迟、token 节省、
 * 分段命中率），再加上它没有的那一组 —— 六道闸各拦下了多少、驱逐是谁判的。
 *
 * **刻意不算正命中率与正确拒绝率。** 那两个要标签：得知道复用的那次「答案对不对」，
 * 而线上没有这个信息。LangCache 的看板同样不给，他们用 LLM-as-a-judge 抽样补。
 * 想要这两个数走 `Evaluation.ts` 的标注集，或对线上流量抽样人工判。
 * 把一个需要标签的数摆在只有计数的看板上，等于请人误读。
 */
export interface MetricsSnapshot {
	readonly requests: number;
	/** 复用了缓存（含精确命中与微调复用） */
	readonly hits: number;
	readonly misses: number;
	/** hits / requests。requests 为 0 时是 0，不是 NaN */
	readonly hitRate: number;
	readonly byOutcome: Readonly<Record<"exact" | "reuse" | "refine" | "generated", number>>;
	/**
	 * 未命中时**被哪道闸拦下**。这是 LangCache 那类单阈值缓存给不出的东西：
	 * 它只有「命中/未命中」，semcache 能说出是问题侧不像（③④）、资料改版了（⑤）、
	 * 还是旧答案不再被支撑（⑥）—— 三种未命中的处理方式完全不同。
	 */
	readonly missedAtGate: Readonly<Partial<Record<GateId, number>>>;
	/** 驱逐了多少条，以及是谁判的。从 trace 里数，不需要存储配合 */
	readonly evictions: { readonly total: number; readonly bySourceVersion: number; readonly byAnswerCheck: number };
	/**
	 * 延迟分位。**命中与未命中分开** —— 混在一起的均值会被命中的那几毫秒拉平，
	 * 看不出未命中要付的那次生成。
	 */
	readonly latencyMs: {
		readonly hit: LatencyStats;
		readonly miss: LatencyStats;
	};
	/**
	 * 省下的生成次数 = 命中数。给了 `costPerGeneration` 才折算成钱 ——
	 * 单价是调用方的事，库不猜。
	 */
	readonly saved: { readonly generations: number; readonly cost: number | null };
	/** 分段命中率，段由调用方给（scope、租户、话题…）。对应 LangCache 的按类别看命中率 */
	readonly bySegment: ReadonlyArray<{ readonly segment: string; readonly requests: number; readonly hits: number; readonly hitRate: number }>;
}

export interface LatencyStats {
	readonly count: number;
	readonly p50: number;
	readonly p95: number;
	readonly max: number;
}

export interface MetricsOptions {
	/** 一次生成的成本，用来把「省下 N 次生成」折算成钱。不给就只报次数 */
	readonly costPerGeneration?: number;
	/**
	 * 每段最多留多少条延迟样本（水塘之外的直接丢）。默认 2048 ——
	 * 看板要的是分位数，不是全量；无上限的数组在长跑进程里就是内存泄漏。
	 */
	readonly latencySamples?: number;
}

export interface MetricsRecording {
	readonly result: CacheResult;
	/** 这一次 resolve 的墙钟耗时。不给就不进延迟统计 */
	readonly ms?: number;
	/** 分段键。不给就不进分段统计 */
	readonly segment?: string;
}

export interface Metrics {
	record(entry: MetricsRecording): void;
	snapshot(): MetricsSnapshot;
	reset(): void;
}

const HIT_OUTCOMES = new Set(["exact", "reuse", "refine"]);

function percentile(sorted: ReadonlyArray<number>, q: number): number {
	if (sorted.length === 0) return 0;
	// 最近秩法：小样本下不做插值，避免报出一个没真实出现过的延迟
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
	const byOutcome = { exact: 0, reuse: 0, refine: 0, generated: 0 };
	const missedAtGate = new Map<GateId, number>();
	let evictedByVersion = 0;
	let evictedByAnswer = 0;
	let hitLatency: Array<number> = [];
	let missLatency: Array<number> = [];
	const segments = new Map<string, { requests: number; hits: number }>();

	/** 环形替换：超过上限就覆盖最早的样本，保持内存有界又不整体丢弃分布 */
	let hitCursor = 0;
	let missCursor = 0;
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
			if (hit) hits += 1;
			byOutcome[result.outcome] += 1;

			if (!hit && result.exitedAt !== null) {
				missedAtGate.set(result.exitedAt, (missedAtGate.get(result.exitedAt) ?? 0) + 1);
			}

			// 驱逐是谁判的 —— trace 里 ⑤⑥ 的 exit 就是驱逐，不需要存储回报
			for (const step of result.trace) {
				if (step.verdict !== "exit") continue;
				if (step.gate === 5) evictedByVersion += 1;
				else if (step.gate === 6) evictedByAnswer += 1;
			}

			if (ms !== undefined) {
				if (hit) hitCursor = push(hitLatency, hitCursor, ms);
				else missCursor = push(missLatency, missCursor, ms);
			}
			if (segment !== undefined) {
				const bucket = segments.get(segment) ?? { requests: 0, hits: 0 };
				bucket.requests += 1;
				if (hit) bucket.hits += 1;
				segments.set(segment, bucket);
			}
		},

		snapshot() {
			const gates: Partial<Record<GateId, number>> = {};
			for (const [gate, n] of [...missedAtGate.entries()].sort((a, b) => a[0] - b[0])) gates[gate] = n;
			return {
				requests,
				hits,
				misses: requests - hits,
				hitRate: requests === 0 ? 0 : hits / requests,
				byOutcome: { ...byOutcome },
				missedAtGate: gates,
				evictions: {
					total: evictedByVersion + evictedByAnswer,
					bySourceVersion: evictedByVersion,
					byAnswerCheck: evictedByAnswer,
				},
				latencyMs: { hit: stats(hitLatency), miss: stats(missLatency) },
				saved: { generations: hits, cost: cost === undefined ? null : hits * cost },
				bySegment: [...segments.entries()]
					.map(([segment, b]) => ({ segment, requests: b.requests, hits: b.hits, hitRate: b.requests === 0 ? 0 : b.hits / b.requests }))
					.sort((a, b) => b.requests - a.requests),
			};
		},

		reset() {
			requests = 0;
			hits = 0;
			byOutcome.exact = 0;
			byOutcome.reuse = 0;
			byOutcome.refine = 0;
			byOutcome.generated = 0;
			missedAtGate.clear();
			evictedByVersion = 0;
			evictedByAnswer = 0;
			hitLatency = [];
			missLatency = [];
			hitCursor = 0;
			missCursor = 0;
			segments.clear();
		},
	};
}
