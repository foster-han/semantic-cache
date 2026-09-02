/**
 * The two model roles. **They compare different kinds of things and must not share one model.**
 *
 * The distinction is not fastidiousness; it was measured. Point a passage reranker (ms-marco) at
 * question-to-question comparison and, on Chinese input, four sets of decreasing difficulty all
 * land between 0.9975 and 0.9988 — a spread of 0.0013. Go the other way and use a sentence-pair
 * similarity model (paraphrase-*) for question-to-passage retrieval, and the top hit for "what is
 * overfitting?" comes back as "batch normalization" (0.366).
 *
 * **Neither mistake raises an error**: the model loads, returns legitimate 0–1 scores, and the
 * program runs to completion. So the roles are separated at the type level, and every role is
 * required to pass `checkDiscrimination` before it goes live.
 *
 * **There used to be a third role here, `RetrievalEncoder` (question-to-passage)**, used by gate
 * ⑥ answer validation. Gate ⑥ has been removed and retrieval handed back to the caller's own RAG,
 * so the role no longer belongs to this library. The retrieval-misapplication measurement above is
 * kept because it demonstrates that roles cannot be shared, which is not a claim about ⑥.
 */

/** Question ↔ question (symmetric). Used to recall cache entries. */
export interface PairEncoder {
	/** A batch of questions → normalized vectors. Dimensions must be consistent within one implementation. */
	embedQuestions(texts: ReadonlyArray<string>): Promise<Array<Array<number>>>;
}

/**
 * **What** gate ④ hands the reranker as the candidate. It decides which kind of model you need,
 * and it decides the score scale.
 *
 * - `"question"` — new question ↔ the cached old question → needs a model trained on
 *   sentence pairs / duplicate questions
 * - `"answer"` — new question ↔ the cached old answer → exactly query→passage, so a passage
 *   reranker applies
 *
 * **This is not a matter of taste with two acceptable answers; the difference was measured.** Same
 * 18 Chinese pairs, same `bge-reranker-base` (trained for query→passage), changing only the form:
 *
 * | Form | Leave-one-out | Training error | False negatives (legitimate reuse cut) |
 * |---|---|---|---|
 * | `"question"` | 50.0% (a coin flip) | 6/18 | 1 |
 * | `"answer"` | **27.8%** | 4/18 | **0** |
 *
 * Driving false negatives to zero is the important part: the finding that "④ enabled buys no
 * precision and cuts two legitimate reuses" was caused by false negatives. A paraphrase with no
 * vocabulary overlap at all ("what are ensemble methods?" / "why does combining several models
 * work better?") scores 0.0001 under `"question"` and 0.5573 under `"answer"`.
 *
 * **Both columns are given because they say different things.** The training-error column picks
 * its threshold on the same data it is scored on, so it is optimistic; the leave-one-out column is
 * the generalization estimate. And **the comparison between forms is far more robust than either
 * threshold's absolute value** — it is a paired comparison over the same pairs and the same model,
 * changing only the candidate, and it needs no threshold to be pinned down. This data cannot pin
 * one down anyway: at n=18 the plateau is 0.62 wide and the bootstrap 95% interval runs
 * 0.287–0.999. So: choose `"answer"` as the form, but **calibrate your own floor on your own
 * data.**
 *
 * The converse holds too. Move an NLI model from `"question"` to `"answer"` and it collapses
 * outright (5/9 false negatives, median margin goes negative) — a short question entailing a long
 * answer is the wrong direction to begin with. **Changing the form is as much a source of
 * misapplication as changing the model, so either one requires recalibrating θq alongside it.**
 */
export type RerankTarget = "question" | "answer";

/** Reranking. Scores are 0–1 by convention, higher is more relevant. `RerankTarget` decides what the candidate is. */
export interface Reranker {
	score(query: string, candidate: string): Promise<number>;
}

export type EncoderRole = "pair" | "rerank";
