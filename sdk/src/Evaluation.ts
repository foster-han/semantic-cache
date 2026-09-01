import type { Chunk } from "./types/Retrieval.ts";
import type { CachePrompt, Generate } from "./types/Pipeline.ts";
import type { SemanticCache } from "./SemanticCache.ts";

/**
 * 离线标定用的评测。
 *
 * **判据是「答案的首要依据是不是那篇资料」，不是「有没有复用」。**
 * 一旦缓存里有真实规模的历史条目，探测问题可能命中另一条**内容正确**的缓存 ——
 * 那是成功不是失败。而且判据必须落在首要依据上：期望文档只要出现在 top-k 里
 * 就算过，会把「复用了过拟合的答案给问欠拟合的学生」判成通过。
 */
export interface Scenario {
	readonly key: string;
	readonly label: string;
	/** 先问一次，让它进缓存 */
	readonly seed: CachePrompt;
	/** 再问一次，看怎么判 */
	readonly probe: CachePrompt;
	/** 探测的答案必须以哪篇资料为首要依据 */
	readonly expectSourceId: string;
	/** 播种与探测之间执行，用于模拟语料改版 */
	readonly between?: () => Promise<void>;
}

export interface ScenarioOutcome {
	readonly key: string;
	readonly label: string;
	readonly expectSourceId: string;
	readonly actualSourceIds: ReadonlyArray<string>;
	readonly primarySource: string | null;
	readonly outcome: string;
	readonly exitedAt: number | null;
	readonly ok: boolean;
	/** 复用了缓存但首要依据不对 —— 学生拿到错答案 */
	readonly falseHit: boolean;
}

export interface EvaluationReport {
	readonly rows: ReadonlyArray<ScenarioOutcome>;
	readonly total: number;
	readonly passed: number;
	readonly falseHits: number;
}

export interface EvaluationHooks {
	/** 每条场景前调用，用于清空缓存与还原语料 */
	readonly reset: () => Promise<void>;
	/** 灌入干扰缓存。不灌的话召回永远只有 1 条候选，精排没有候选可排 */
	readonly warm?: (cache: SemanticCache, generate: Generate) => Promise<void>;
}

/**
 * 「复用了旧答案」的那几种结果。假命中只可能发生在它们身上 ——
 * `generated` 是新生成的，`bypassed` 是压根没查缓存，都谈不上假命中。
 */
const REUSED_OUTCOMES: ReadonlySet<string> = new Set(["exact", "reuse", "refine"]);

export async function evaluate(
	cache: SemanticCache,
	scenarios: ReadonlyArray<Scenario>,
	generate: Generate,
	hooks: EvaluationHooks,
): Promise<EvaluationReport> {
	const rows: Array<ScenarioOutcome> = [];
	for (const s of scenarios) {
		await hooks.reset();
		if (hooks.warm) await hooks.warm(cache, generate);
		await cache.resolve(s.seed, generate);
		if (s.between) await s.between();
		const result = await cache.resolve(s.probe, generate);
		const primary = result.sourceIds[0] ?? null;
		const ok = primary === s.expectSourceId;
		rows.push({
			key: s.key,
			label: s.label,
			expectSourceId: s.expectSourceId,
			actualSourceIds: result.sourceIds,
			primarySource: primary,
			outcome: result.outcome,
			exitedAt: result.exitedAt,
			ok,
			// **正向判据。**先前是 `outcome !== "generated"` —— 加一个新的 Outcome
			// （比如 "bypassed"：压根没查缓存、真生成的）就会被误计成假命中。
			// 假命中的定义是「复用了缓存，但答案的依据不对」，只有命中类才算得上。
			falseHit: !ok && REUSED_OUTCOMES.has(result.outcome),
		});
	}
	return {
		rows,
		total: rows.length,
		passed: rows.filter(r => r.ok).length,
		falseHits: rows.filter(r => r.falseHit).length,
	};
}

/**
 * A/B：同一批场景跑两套配置，差值就是那道闸的价值。
 * 差值为 0 时如实返回 0 —— 一道闸在你的数据上没用，这个事实本身有价值。
 */
export interface ComparisonReport {
	readonly a: EvaluationReport;
	readonly b: EvaluationReport;
	readonly falseHitDelta: number;
	/** 在 A 里通过、在 B 里失败的场景 */
	readonly regressed: ReadonlyArray<string>;
}

export function compare(a: EvaluationReport, b: EvaluationReport): ComparisonReport {
	const bByKey = new Map(b.rows.map(r => [r.key, r]));
	return {
		a,
		b,
		falseHitDelta: b.falseHits - a.falseHits,
		regressed: a.rows.filter(r => r.ok && bByKey.get(r.key)?.ok === false).map(r => r.label),
	};
}

/** 便利：把一组片段拼成 sourceIds，顺序即重要性。 */
export function sourceIdsOf(chunks: ReadonlyArray<Chunk>): Array<string> {
	return chunks.map(c => c.id);
}
