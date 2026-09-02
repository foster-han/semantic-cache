import type { SemanticCache } from "./SemanticCache.ts";
import type { CachePrompt, Generate } from "./types/Pipeline.ts";

/**
 * Evaluation for offline calibration.
 *
 * **The criterion is which space the answer came from, not whether anything was reused.** Once the
 * cache holds history at realistic scale, a probe question may hit a different entry whose content
 * is **correct** — that is a success, not a failure.
 *
 * The criterion used to be finer: entries recorded the source documents they cited, and a scenario
 * asserted that the probe's answer rested primarily on one named document. That dimension has been
 * removed — an entry now records only the space it belongs to — so the assertion is coarser by
 * exactly that much. **On a corpus with a single space it is very nearly a tautology**, and a
 * scenario suite living in one space will report a false-hit count of zero because there is no
 * second space to be wrong about, not because nothing went wrong. Sizing a suite across several
 * spaces is what gives this criterion teeth.
 */
export interface Scenario {
	readonly key: string;
	readonly label: string;
	/** Asked first, to put it in the cache. */
	readonly seed: CachePrompt;
	/** Asked again, to see how it is judged. */
	readonly probe: CachePrompt;
	/**
	 * Which space the probe's answer must come from — the resolved scope, as `composeScope(org, key)`
	 * builds it, not the bare `ScopeDecision.key`.
	 */
	readonly expectSpace: string;
	/** Runs between seeding and probing, to simulate the material being revised. */
	readonly between?: () => Promise<void>;
}

export interface ScenarioOutcome {
	readonly key: string;
	readonly label: string;
	readonly expectSpace: string;
	readonly actualSpace: string;
	readonly outcome: string;
	readonly exitedAt: number | null;
	readonly ok: boolean;
	/** The cache was reused but the answer came from another space — the student got somebody else's answer. */
	readonly falseHit: boolean;
}

export interface EvaluationReport {
	readonly rows: ReadonlyArray<ScenarioOutcome>;
	readonly total: number;
	readonly passed: number;
	readonly falseHits: number;
}

export interface EvaluationHooks {
	/** Called before each scenario, to clear the cache and restore the corpus. */
	readonly reset: () => Promise<void>;
	/** Seeds distractor entries. Without them recall only ever has one candidate and reranking has nothing to rank. */
	readonly warm?: (cache: SemanticCache, generate: Generate) => Promise<void>;
}

/**
 * The outcomes that mean "an old answer was reused". A false hit can only occur among these —
 * `generated` produced something new and `bypassed` never consulted the cache, so neither can be
 * a false hit.
 */
const REUSED_OUTCOMES: ReadonlySet<string> = new Set(["exact", "reuse"]);

export async function evaluate(
	cache: SemanticCache,
	scenarios: ReadonlyArray<Scenario>,
	generate: Generate,
	hooks: EvaluationHooks,
): Promise<EvaluationReport> {
	const rows: Array<ScenarioOutcome> = [];
	for (const s of scenarios) {
		await hooks.reset();
		if (hooks.warm) {
			await hooks.warm(cache, generate);
		}
		await cache.resolve(s.seed, generate);
		if (s.between) {
			await s.between();
		}
		const result = await cache.resolve(s.probe, generate);
		const ok = result.scope === s.expectSpace;
		rows.push({
			key: s.key,
			label: s.label,
			expectSpace: s.expectSpace,
			actualSpace: result.scope,
			outcome: result.outcome,
			exitedAt: result.exitedAt,
			ok,
			// **A positive criterion.** It used to be `outcome !== "generated"`, which meant adding a
			// new Outcome (say "bypassed": the cache was never consulted and generation really ran)
			// would be miscounted as a false hit. A false hit is defined as "the cache was reused but
			// the answer came from the wrong space", so only hit-like outcomes can qualify.
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
 * A/B: run the same scenarios under two configurations, and the difference is that gate's value.
 * A difference of 0 is reported as 0 — a gate being useless on your data is itself a valuable fact.
 */
export interface ComparisonReport {
	readonly a: EvaluationReport;
	readonly b: EvaluationReport;
	readonly falseHitDelta: number;
	/** Scenarios that passed in A and failed in B. */
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
