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
	readonly byOutcome: Readonly<Record<"exact" | "reuse" | "refine" | "generated" | "bypassed", number>>;
	/**
	 * 策略绕开的次数，**按理由分组**。
	 *
	 * `missedAtGate` 回答「查了但没用上，是哪道闸拦的」；这一项回答「压根没查，
	 * 是哪条规则说的」。少了它，一次策略误配（上游某个信号一直是开的）只表现为
	 * 命中率下降，而看板上查不出原因 —— 那正是主流框架里静默 no-op 的病根。
	 */
	readonly bypassedByReason: Readonly<Record<string, number>>;
	/**
	 * 未命中时**被哪道闸拦下**。这是 LangCache 那类单阈值缓存给不出的东西：
	 * 它只有「命中/未命中」，semcache 能说出是问题侧不像（③④）、资料改版了（⑤）、
	 * 还是旧答案不再被支撑（⑥）—— 三种未命中的处理方式完全不同。
	 */
	readonly missedAtGate: Readonly<Partial<Record<GateId, number>>>;
	/**
	 * **真的删掉了多少条**，以及是谁判的。数的是 trace 上的 `evicted`，不需要存储配合。
	 *
	 * 不数 `verdict === "exit"`：⑥ 的 exit 有一半什么都没删（判不了、答案无依据不写入、
	 * 中带微调失败），影子模式下 ⑤⑥ 判负也一律不删。理由见 `GateTrace.evicted`。
	 */
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
	 * **完整省下的生成次数** = `exact + reuse`。给了 `costPerGeneration` 才折算成钱 ——
	 * 单价是调用方的事，库不猜。
	 *
	 * **`refine` 不算在内。** 它复用了旧答案，但确实跑了一次短生成 —— 记成整次省下
	 * 就是把节省报高。中带占比一旦上去（`support.midBandRate` 正是看这个），报高的
	 * 幅度就不是可以忽略的零头。refine 的次数在 `byOutcome.refine` 里，想按短生成的
	 * 单价折算用它自己乘 —— 长短两种生成的单价不一样，库不替调用方假设那个比例。
	 */
	readonly saved: { readonly generations: number; readonly cost: number | null };
	/** 分段命中率，段由调用方给（scope、租户、话题…）。对应 LangCache 的按类别看命中率 */
	readonly bySegment: ReadonlyArray<{ readonly segment: string; readonly requests: number; readonly hits: number; readonly hitRate: number }>;
	/**
	 * ⑥ 支撑度的分布。**命中率回答「省了多少」，这个回答「离翻车多远」。**
	 *
	 * 标定用的是几十条探针，线上是真实流量 —— 两者的分布不一定一样，而
	 * FINDINGS 里那条「平台宽其实可以是好消息：风险只在于真实数据把空隙填满」
	 * 只有在这里能被持续验证。数值取自 ⑥ 的 trace（`gate === 6` 且带 `score`），
	 * 不需要额外计算。
	 */
	readonly support: {
		/** 命中时的支撑度。闸关着时的 `would-exit` 也算在这里 —— 那次确实复用了 */
		readonly onHit: SupportStats;
		/**
		 * **被 ⑥ 判负时**的支撑度。它贴近 θa低 说明阈值太紧，正在杀合法复用。
		 *
		 * 这里认的是「判负」而不是「真删了」—— 影子模式下判负不驱逐，但那次判定
		 * 照样是分布上的一个点，漏掉它影子模式就量不出「上线后 ⑥ 会拦掉什么」。
		 * 与 `evictions` 刻意不同源：那个数的是动作，这个数的是判定。
		 */
		readonly onEvict: SupportStats;
		/**
		 * 最险的 10% 命中离 θa高 还剩多少余量（`onHit.p10 − high`）。
		 * **它往下掉比命中率下降更早**。没给 `supportThresholds` 时为 null。
		 */
		readonly headroomP10: number | null;
		/** 命中里落进微调带（`low ≤ s < high`）的比例。它涨说明分布在往阈值上靠 */
		readonly midBandRate: number | null;
	};
	/**
	 * 影子模式的账。`shadow: true` 时才有意义 —— 全部请求都真生成，
	 * 这里记的是「**本来**会不会复用」。
	 */
	readonly shadow: { readonly requests: number; readonly wouldReuse: number; readonly wouldReuseRate: number };
}

/**
 * 支撑度的分布。**分位取 p10/p50/p90 而不是 p50/p95/max** —— 延迟看的是尾部大的那端，
 * 支撑度看的是尾部**小**的那端：一次 0.9675 的命中（θa高 0.967）和一次 0.9990 的命中
 * 在命中率上完全一样，但前者只比阈值高 0.0005。
 */
export interface SupportStats {
	readonly count: number;
	readonly p10: number;
	readonly p50: number;
	readonly p90: number;
	readonly min: number;
	readonly max: number;
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
	 * 每段最多留多少条样本（超出的环形覆盖）。默认 2048 —— 看板要的是分位数，
	 * 不是全量；无上限的数组在长跑进程里就是内存泄漏。
	 *
	 * **延迟与支撑度共用这个上限**，各自独立计数：命中延迟、未命中延迟、
	 * 命中支撑度、驱逐支撑度各一段。
	 */
	readonly latencySamples?: number;
	/**
	 * ⑥ 的两档阈值。给了才算得出 `headroomP10` 与 `midBandRate` ——
	 * 「离阈值还有多远」这个问题没有阈值就没有答案。
	 *
	 * 必须和 `SupportStage.thresholds` 是同一组值。库这边不去读缓存实例的配置：
	 * 指标层刻意不碰其它组件，只吃 `CacheResult`。
	 */
	readonly supportThresholds?: { readonly high: number; readonly low: number };
	/**
	 * `bypassedByReason` 与 `bySegment` 各自最多留多少个**真实**键。默认 256，
	 * 超出的归入 `"（其它）"` —— 所以快照里最多是 `maxDistinctKeys + 1` 项。
	 *
	 * 计数一条都不丢：溢出的请求进「其它」桶，总数仍然对得上。
	 *
	 * 这两个 Map 的键都不完全受库控制：分段键由调用方给，而绕开理由里内嵌了
	 * `context` 来的调用类型 —— 基数无界。延迟样本早就防过同一件事（环形有界），
	 * 这两处先前漏了：长跑进程里一个拼错的 `callType` 就能把它们撑爆。
	 */
	readonly maxDistinctKeys?: number;
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

function supportStats(samples: ReadonlyArray<number>): SupportStats {
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		count: sorted.length,
		p10: percentile(sorted, 0.1),
		p50: percentile(sorted, 0.5),
		p90: percentile(sorted, 0.9),
		min: sorted.length === 0 ? 0 : sorted[0],
		max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
	};
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
	const byOutcome = { exact: 0, reuse: 0, refine: 0, generated: 0, bypassed: 0 };
	const bypassedByReason = new Map<string, number>();
	const thresholds = options?.supportThresholds;
	const maxKeys = options?.maxDistinctKeys ?? 256;
	const OVERFLOW = "（其它）";
	/** 满了就把新键归入「其它」—— 已在表里的照常累加，不丢已有的统计 */
	function bump<T>(map: Map<string, T>, key: string, next: (previous: T | undefined) => T): void {
		const slot = map.has(key) || map.size < maxKeys ? key : OVERFLOW;
		map.set(slot, next(map.get(slot)));
	}
	const supportOnHit: Array<number> = [];
	const supportOnEvict: Array<number> = [];
	let supportCursor = 0;
	let evictCursor = 0;
	let shadowRequests = 0;
	let shadowWouldReuse = 0;
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
			if (result.outcome === "bypassed") {
				bump(bypassedByReason, result.bypassReason ?? "（未给理由）", previous => (previous ?? 0) + 1);
			}

			if (!hit && result.exitedAt !== null) {
				missedAtGate.set(result.exitedAt, (missedAtGate.get(result.exitedAt) ?? 0) + 1);
			}

			if (result.wouldReuse !== null) {
				shadowRequests += 1;
				if (result.wouldReuse) shadowWouldReuse += 1;
			}

			// ⑤⑥ 的判定与驱逐。**判定看 verdict，驱逐看 evicted** —— 两者刻意不同源
			for (const step of result.trace) {
				/**
				 * ⑥ 的支撑度。**认「gate 6 且带 score」而不是认名字** —— 同一道闸
				 * 在 trace 里还有「写入」「中带处理」两种条目，它们不带 score。
				 */
				if (step.gate === 6 && step.score !== undefined) {
					if (step.verdict === "exit") evictCursor = push(supportOnEvict, evictCursor, step.score);
					else if (hit) supportCursor = push(supportOnHit, supportCursor, step.score);
				}
				/**
				 * **认 `evicted` 而不是认 verdict。**理由见 `GateTrace.evicted` —— 反推的话
				 * retriever 一次故障就能让看板报出满屏「⑥ 判负驱逐」，而缓存一条没动。
				 */
				if (step.evicted !== true) continue;
				if (step.gate === 5) evictedByVersion += 1;
				else if (step.gate === 6) evictedByAnswer += 1;
			}

			if (ms !== undefined) {
				if (hit) hitCursor = push(hitLatency, hitCursor, ms);
				else missCursor = push(missLatency, missCursor, ms);
			}
			if (segment !== undefined) {
				bump(segments, segment, previous => {
					const bucket = previous ?? { requests: 0, hits: 0 };
					bucket.requests += 1;
					if (hit) bucket.hits += 1;
					return bucket;
				});
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
				support: (() => {
					const onHit = supportStats(supportOnHit);
					const midBand =
						thresholds === undefined || supportOnHit.length === 0
							? null
							: supportOnHit.filter(v => v >= thresholds.low && v < thresholds.high).length / supportOnHit.length;
					return {
						onHit,
						onEvict: supportStats(supportOnEvict),
						// 余量就是「最险的 10% 离阈值还有多远」，没有样本时给不出数
						headroomP10: thresholds === undefined || onHit.count === 0 ? null : onHit.p10 - thresholds.high,
						midBandRate: midBand,
					};
				})(),
				shadow: {
					requests: shadowRequests,
					wouldReuse: shadowWouldReuse,
					wouldReuseRate: shadowRequests === 0 ? 0 : shadowWouldReuse / shadowRequests,
				},
				bypassedByReason: Object.fromEntries([...bypassedByReason.entries()].sort((a, b) => b[1] - a[1])),
				missedAtGate: gates,
				evictions: {
					total: evictedByVersion + evictedByAnswer,
					bySourceVersion: evictedByVersion,
					byAnswerCheck: evictedByAnswer,
				},
				latencyMs: { hit: stats(hitLatency), miss: stats(missLatency) },
				// refine 跑了一次短生成，不算整次省下 —— 见 saved 的注释
				saved: (() => {
					const fully = byOutcome.exact + byOutcome.reuse;
					return { generations: fully, cost: cost === undefined ? null : fully * cost };
				})(),
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
			byOutcome.bypassed = 0;
			bypassedByReason.clear();
			supportOnHit.length = 0;
			supportOnEvict.length = 0;
			supportCursor = 0;
			evictCursor = 0;
			shadowRequests = 0;
			shadowWouldReuse = 0;
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
