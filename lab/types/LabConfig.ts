/**
 * 验证台的开关与阈值。
 *
 * 注意 `thetaQ` 在传与不传 reranker 两种情况下**尺度完全不同**
 * （重排器的 sigmoid vs 召回余弦）——阈值属于打分器，不属于流水线。
 * 换打分器必须连阈值一起重标，这个坑在实验设计上踩过一次。
 */
export interface LabConfig {
	/** ① 检出实体就强制 user scope */
	readonly gate1: boolean;
	/** ④ 精排 */
	readonly gate4: boolean;
	/** ⑤ 资料版本比对 */
	readonly gate5: boolean;
	/** ⑥ 回答有效性校验 */
	readonly gate6: boolean;
	/** ⑥ 的检索用保留实体的原文（那条硬前提） */
	readonly preAnonRetrieval: boolean;
	/** 上层是否如实声明已脱敏；声明后 SDK 拒绝把 answer 条目放进共享 scope */
	readonly declareRedacted: boolean;
	/** 缓存 pre-filter 粒度 */
	readonly scopeMode: "course" | "unit";
	readonly thetaQ: number;
	readonly recallFloor: number;
	readonly thetaAHi: number;
	readonly thetaALo: number;
	readonly topK: number;
	readonly chunkK: number;
	readonly chunkCut: number;
	/** 检索时非当前章节的片段打的折扣 */
	readonly unitBoost: number;
}

export interface LabCounters {
	ask: number;
	exact: number;
	reuse: number;
	refine: number;
	generated: number;
}
