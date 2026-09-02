import type { PairEncoder, Reranker, RerankTarget } from "./Encoders.ts";

/**
 * Binds a scorer to the thresholds **calibrated for it**.
 *
 * Keeping them apart is a mistake. A field like `rerankFloor` lives on a completely different
 * scale once the scorer changes — a reranker's sigmoid and a bi-encoder's cosine are not the same
 * quantity, and 0.979 means "barely separable" for the former and "almost nothing gets through"
 * for the latter. That confusion once produced a control experiment here that looked normal and
 * was in fact absurdly strict, and very nearly yielded the conclusion that reranking has no value.
 *
 * **A threshold belongs to its scorer, not to the pipeline.** Swapping the scorer means
 * recalibrating, so the types tie them together: take a new scorer and you cannot keep the old
 * numbers.
 */
export interface Calibrated<TScorer, TThresholds> {
	readonly scorer: TScorer;
	readonly thresholds: TThresholds;
	/**
	 * What data and what operator these thresholds were calibrated on. **Required.**
	 *
	 * A threshold means nothing outside its calibration context — new corpus, recalibrate; new
	 * operator, recalibrate; new model, recalibrate above all. One sentence written down now is
	 * far cheaper than archaeology later.
	 */
	readonly calibratedOn: string;
}

/** Gate ③ recall: the question-to-question cosine scale. */
export type RecallStage = Calibrated<PairEncoder, { readonly floor: number }>;

/**
 * Gate ④ rerank: the reranker's own score scale.
 *
 * **Omitting it means the gate does not exist.** It does not degrade into "reuse this floor
 * against the recall cosine" — that degradation is exactly where scale confusion comes from, so
 * the path was removed. To tighten the question side, raise `RecallStage`'s floor, which is the
 * value actually denominated in cosine.
 *
 * **`target` lives inside `thresholds` rather than in a field of its own.** It is not a threshold,
 * but it determines the score scale: for one and the same `bge-reranker-base`, the optimal floor
 * is 0.1228 for question-to-question and 0.3494 for question-to-answer. Changing the form without
 * recalibrating θq is the same mistake as changing the model without recalibrating θq, so the
 * types put them in one object — change the form and you must supply a new floor, because the old
 * one is out of reach.
 *
 * There is no default. `"question"` looks like the natural one, but it is precisely the branch
 * that misapplies the only kind of model readily available (rerankers trained for query→passage).
 * Defaulting to a value that fails silently would cancel out the point of this type.
 */
export type RerankStage = Calibrated<Reranker, { readonly floor: number; readonly target: RerankTarget }>;
