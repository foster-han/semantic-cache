/**
 * 验证台的开关与阈值。
 *
 * 注意 `thetaQ` 在传与不传 reranker 两种情况下**尺度完全不同**
 * （重排器的 sigmoid vs 召回余弦）——阈值属于打分器，不属于流水线。
 * 换打分器必须连阈值一起重标，这个坑在实验设计上踩过一次。
 *
 * **四个阈值的默认值不在这里，在 `../Calibrations.ts`**：它们随语料、编码器、
 * 生成端而变，写死一份就等于把某一个组合上标出来的数当成普适值 —— FINDINGS 里
 * 英文那一轮之所以从干净 checkout 复现不出来，就是因为先前只有一份硬编码的默认值。
 */
export interface LabConfig {
	/** ① 检出实体就强制 user scope */
	readonly gate1: boolean;
	/** ④ 精排 */
	readonly gate4: boolean;
	/** ⑤ 资料版本比对 */
	readonly gate5: boolean;
	/** 检索用保留实体的原文（匿名化文本去检索会让两个学生检出同一批片段） */
	readonly preAnonRetrieval: boolean;
	/** 上层是否如实声明已脱敏；声明后 SDK 拒绝把 answer 条目放进共享 scope */
	readonly declareRedacted: boolean;
	/** 缓存 pre-filter 粒度 */
	readonly scopeMode: "course" | "unit";
	/**
	 * ④ 的闸值。**`null` = 这个组合下没有有效标定**，此时 ④ 不存在。
	 *
	 * 不给它一个占位数字，是因为占位数字会变成一道「恒放行」的假闸：默认重排器在
	 * 中文上饱和在 0.9975–0.9988，随手填个 0.55 的话 ④ 会放过一切，而页面上看起来
	 * 这道闸是开着的 —— 「④ 值不值」那张对照卡因此永远输出「两边一模一样」。
	 */
	readonly thetaQ: number | null;
	readonly recallFloor: number;
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
	generated: number;
}
