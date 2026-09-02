import type { PairEncoder, Reranker, RerankTarget } from "./Encoders.ts";

/**
 * 一个打分器和**为它标定的**阈值绑在一起。
 *
 * 分开放是错的。`rerankFloor` 这类字段在换了打分器之后尺度完全不同 ——
 * 重排器的 sigmoid 和 bi-encoder 的余弦不是一回事，0.979 在前者是"勉强可分"，
 * 在后者是"几乎什么都过不去"。实测里我就因此造出过一个看起来正常、
 * 实则严到荒谬的对照实验，并据此差点写下"精排没有价值"的结论。
 *
 * **阈值属于打分器，不属于流水线。**换打分器必须连阈值一起重标，
 * 所以类型上把它们捆在一起，换一个就拿不到旧的。
 */
export interface Calibrated<TScorer, TThresholds> {
	readonly scorer: TScorer;
	readonly thresholds: TThresholds;
	/**
	 * 这组阈值在什么数据、什么算子下标出来的。**必填。**
	 *
	 * 阈值离开标定语境就没有意义 —— 换语料要重标，换算子要重标，
	 * 换模型更要重标。写一句话记下来，比事后考古便宜得多。
	 */
	readonly calibratedOn: string;
}

/** ③ 召回：问题↔问题的余弦尺度 */
export type RecallStage = Calibrated<PairEncoder, { readonly floor: number }>;

/**
 * ④ 精排：该重排器自己的分数尺度。
 *
 * **不提供就是没有这道闸**，不会退化成"拿这个闸值去卡召回余弦" ——
 * 那条退化路径正是尺度混用的来源，所以直接删掉了。想收紧问题侧，
 * 提高 `RecallStage` 的 floor（那才是余弦尺度）。
 *
 * **`target` 住在 thresholds 里，而不是另开一个字段。** 它不是阈值，但它决定
 * 分数尺度：同一个 `bge-reranker-base`，问↔问的最优闸值是 0.1228，问↔答是
 * 0.3494。换形态不重标 θq 和换模型不重标 θq 是同一个错，所以类型上让它们
 * 共用一个对象 —— 改形态就必须给出新的 floor，拿不到旧的。
 *
 * 没有默认值：`"question"` 看着像自然的默认，但它恰好是让唯一可得的那类模型
 * （query→passage 训练的重排器）任务错配的那一支。默认一个会静默失效的值，
 * 等于把这套类型设计的意义抵消掉。
 */
export type RerankStage = Calibrated<Reranker, { readonly floor: number; readonly target: RerankTarget }>;
