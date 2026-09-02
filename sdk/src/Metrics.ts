import type { CacheResult, GateId } from "./types/Pipeline.ts";

/**
 * 指标累加器。**喂 `CacheResult` 进去，不碰时钟、不碰网络、不碰存储。**
 *
 * 对齐 Redis LangCache 看板给的那一组（请求/命中/未命中、命中率、延迟、token 节省、
 * 分段命中率），再加上它没有的那一组 —— 五道闸各拦下了多少、驱逐是谁判的。
 *
 * **刻意不算正命中率与正确拒绝率。** 那两个要标签：得知道复用的那次「答案对不对」，
 * 而线上没有这个信息。LangCache 的看板同样不给，他们用 LLM-as-a-judge 抽样补。
 * 想要这两个数走 `Evaluation.ts` 的标注集，或对线上流量抽样人工判。
 * 把一个需要标签的数摆在只有计数的看板上，等于请人误读。
 */
export interface MetricsSnapshot {
	/** 喂进来的全部请求，含策略绕开的那些 */
	readonly requests: number;
	/**
	 * **真的查了缓存的请求** = `requests − byOutcome.bypassed`。
	 *
	 * 命中率的分母是它，不是 `requests`。绕开的请求一道闸都没跑，把它们算进分母，
	 * 一个策略绕开了大半流量的部署在看板上就长得像「一个什么都命中不了的缓存」——
	 * 而那正是 `bypassedByReason` 这一栏当初要防的误读，只是先前防在了明细上、
	 * 没防在总数上。三个数对得上：`requests = hits + misses + byOutcome.bypassed`。
	 */
	readonly attempted: number;
	/** 复用了缓存（含精确命中与微调复用） */
	readonly hits: number;
	/** **查了但没命中** = `attempted − hits`。绕开的请求不在里面 */
	readonly misses: number;
	/** hits / attempted。attempted 为 0 时是 0，不是 NaN */
	readonly hitRate: number;
	readonly byOutcome: Readonly<Record<"exact" | "reuse" | "generated" | "bypassed", number>>;
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
	 * 它只有「命中/未命中」，semcache 能说出是问题侧不像（③④）还是资料改版了（⑤）——
	 * 两种未命中的处理方式完全不同：前者调阈值或换打分器，后者说明缓存正在按预期失效。
	 */
	readonly missedAtGate: Readonly<Partial<Record<GateId, number>>>;
	/**
	 * **真的删掉了多少条**，以及是谁判的。数的是 trace 上的 `evicted`，不需要存储配合。
	 *
	 * 不数 `verdict === "exit"`：影子模式下 ⑤ 判负一律不删（评估不该改变被评估的东西），
	 * 反推的话看板会报出一批根本没发生的驱逐。理由见 `GateTrace.evicted`。
	 */
	readonly evictions: { readonly total: number; readonly bySourceVersion: number };
	/**
	 * 延迟分位。**命中与未命中分开** —— 混在一起的均值会被命中的那几毫秒拉平，
	 * 看不出未命中要付的那次生成。
	 *
	 * **绕开自成一档**，和 `byOutcome` 里一样。它是「什么缓存都不用」的那条基线：
	 * 未命中付的是召回 + 检索 + 支撑度 + 生成，绕开只付生成。混进 `miss` 会把未命中
	 * 的延迟报低，而那个数正是用来算「缓存这层加了多少开销」的。
	 */
	readonly latencyMs: {
		readonly hit: LatencyStats;
		readonly miss: LatencyStats;
		readonly bypassed: LatencyStats;
	};
	/**
	 * **完整省下的生成次数** = `exact + reuse`。给了 `costPerGeneration` 才折算成钱 ——
	 * 单价是调用方的事，库不猜。
	 *
	 */
	readonly saved: { readonly generations: number; readonly cost: number | null };
	/**
	 * 分段命中率，段由调用方给（scope、租户、话题…）。对应 LangCache 的按类别看命中率。
	 * 分母和全局一样是「真的查了的」（`requests − bypassed`），否则两个命中率会打架。
	 */
	readonly bySegment: ReadonlyArray<{
		readonly segment: string;
		readonly requests: number;
		readonly bypassed: number;
		readonly hits: number;
		readonly hitRate: number;
	}>;
	/**
	 * 影子模式的账。`shadow: true` 时才有意义 —— 全部请求都真生成，
	 * 这里记的是「**本来**会不会复用」。
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
	/** 一次生成的成本，用来把「省下 N 次生成」折算成钱。不给就只报次数 */
	readonly costPerGeneration?: number;
	/**
	 * 每段最多留多少条样本（超出的环形覆盖）。默认 2048 —— 看板要的是分位数，
	 * 不是全量；无上限的数组在长跑进程里就是内存泄漏。
	 *
	 * 三段延迟各自独立计数：命中、未命中、策略绕开。
	 */
	readonly latencySamples?: number;
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

const HIT_OUTCOMES = new Set(["exact", "reuse"]);

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
	const byOutcome = { exact: 0, reuse: 0, generated: 0, bypassed: 0 };
	const bypassedByReason = new Map<string, number>();
	const maxKeys = options?.maxDistinctKeys ?? 256;
	const OVERFLOW = "（其它）";
	/** 满了就把新键归入「其它」—— 已在表里的照常累加，不丢已有的统计 */
	function bump<T>(map: Map<string, T>, key: string, next: (previous: T | undefined) => T): void {
		const slot = map.has(key) || map.size < maxKeys ? key : OVERFLOW;
		map.set(slot, next(map.get(slot)));
	}
	let shadowRequests = 0;
	let shadowWouldReuse = 0;
	const missedAtGate = new Map<GateId, number>();
	let evictedByVersion = 0;
	let hitLatency: Array<number> = [];
	let missLatency: Array<number> = [];
	let bypassLatency: Array<number> = [];
	const segments = new Map<string, { requests: number; bypassed: number; hits: number }>();

	/** 环形替换：超过上限就覆盖最早的样本，保持内存有界又不整体丢弃分布 */
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
			if (hit) hits += 1;
			byOutcome[result.outcome] += 1;
			if (bypassed) {
				bump(bypassedByReason, result.bypassReason ?? "（未给理由）", previous => (previous ?? 0) + 1);
			}

			if (!hit && result.exitedAt !== null) {
				missedAtGate.set(result.exitedAt, (missedAtGate.get(result.exitedAt) ?? 0) + 1);
			}

			if (result.wouldReuse !== null) {
				shadowRequests += 1;
				if (result.wouldReuse) shadowWouldReuse += 1;
			}

			// ⑤ 的驱逐。**认 `evicted` 而不是认 verdict** —— 理由见 `GateTrace.evicted`：
			// 反推的话一次上游故障就能让看板报出满屏「判负驱逐」，而缓存一条没动
			for (const step of result.trace) {
				if (step.evicted !== true) continue;
				if (step.gate === 5) evictedByVersion += 1;
			}

			if (ms !== undefined) {
				// 三档，和 byOutcome 一致：绕开的那次没查缓存，混进 miss 会把未命中报便宜
				if (hit) hitCursor = push(hitLatency, hitCursor, ms);
				else if (bypassed) bypassCursor = push(bypassLatency, bypassCursor, ms);
				else missCursor = push(missLatency, missCursor, ms);
			}
			if (segment !== undefined) {
				bump(segments, segment, previous => {
					const bucket = previous ?? { requests: 0, bypassed: 0, hits: 0 };
					bucket.requests += 1;
					if (bypassed) bucket.bypassed += 1;
					if (hit) bucket.hits += 1;
					return bucket;
				});
			}
		},

		snapshot() {
			const gates: Partial<Record<GateId, number>> = {};
			for (const [gate, n] of [...missedAtGate.entries()].sort((a, b) => a[0] - b[0])) gates[gate] = n;
			// 绕开的请求一道闸都没跑 —— 命中率的分母里不该有它们（见 attempted）
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
				evictions: {
					total: evictedByVersion,
					bySourceVersion: evictedByVersion,
				},
				latencyMs: { hit: stats(hitLatency), miss: stats(missLatency), bypassed: stats(bypassLatency) },
				saved: (() => {
					const fully = byOutcome.exact + byOutcome.reuse;
					return { generations: fully, cost: cost === undefined ? null : fully * cost };
				})(),
				bySegment: [...segments.entries()]
					.map(([segment, b]) => {
						const tried = b.requests - b.bypassed;
						return { segment, requests: b.requests, bypassed: b.bypassed, hits: b.hits, hitRate: tried === 0 ? 0 : b.hits / tried };
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
			evictedByVersion = 0;
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
