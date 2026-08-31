/** 一个检索到的资料片段。`id` 参与版本指纹与首要依据判定。 */
export interface Chunk {
	readonly id: string;
	readonly text: string;
	/** 可选：调用方已有的分数，仅用于排序展示，库不依赖它 */
	readonly score?: number;
}

/**
 * 调用方自己的 RAG 检索。库不实现检索，只在需要时调用它。
 *
 * **传进来的一定是保留实体的原文**（见 CachePrompt.retrievalText）。
 * 如果这里跑的是匿名化之后的文本，回答侧校验对实体塌陷完全失明 ——
 * 两个不同的人会检出同一批片段，这一层就废了。
 *
 * **返回值必须按相关性降序**，`[0]` 是这次最会被据以回答的那一篇。⑥ 的算子固定
 * 为 top-1，比的就是 `chunks[0]` —— 顺序错了这道闸测的就不是「旧答案和现在会据以
 * 回答的那篇一不一致」，而阈值仍然照常算得出来，不会报错。你自己的检索层若返回的是
 * 未排序的集合，请在这里排好再交出来。
 */
export interface Retriever {
	retrieve(retrievalText: string, context: Readonly<Record<string, string>>): Promise<Array<Chunk>>;
}

/**
 * 资料版本指纹。给一组资料 id，返回它们当前版本的指纹字符串。
 *
 * 必须是**引用资料级**的，不是租户级或课程级的 —— 按更粗的粒度算，
 * 任何一处无关改动都会让全部缓存失效，而且会抢走回答侧校验该管的事。
 */
export type SourceVersionResolver = (sourceIds: ReadonlyArray<string>) => Promise<string> | string;
