/**
 * 三个模型角色。**它们比的不是同一类东西，不能共用一个模型。**
 *
 * 这个区分不是洁癖，是实测出来的：拿句对相似度模型（paraphrase-*）去做
 * 问题↔段落的检索，「什么是过拟合？」检出来的第一名是「批归一化」（0.366），
 * 换成检索训练的模型后是「过拟合」（0.888）。拿段落重排器（ms-marco）去比
 * 问题↔问题，中文上四组难度递减的输入全部落在 0.9975–0.9988，跨度 0.0013。
 *
 * 两次错误**都不报错**：模型正常加载、返回合法的 0~1 分数、程序跑完。
 * 所以类型上把三个角色分开，并且要求每个角色上线前过 `checkDiscrimination`。
 */

/** 问题 ↔ 问题（对称）。用于缓存条目的召回。 */
export interface PairEncoder {
	/** 一批问句 → 归一化后的向量。同一实现内维度必须一致。 */
	embedQuestions(texts: ReadonlyArray<string>): Promise<Array<Array<number>>>;
}

/**
 * 问题 ↔ 段落（非对称）。用于检索资料，以及回答有效性校验。
 *
 * 查询侧和文档侧必须分开：E5 一类模型要求 `query:` / `passage:` 前缀，
 * 混用会让分数失去意义。两侧输出必须落在**同一个向量空间**。
 */
export interface RetrievalEncoder {
	embedQuery(texts: ReadonlyArray<string>): Promise<Array<Array<number>>>;
	embedPassage(texts: ReadonlyArray<string>): Promise<Array<Array<number>>>;
}

/**
 * 精排。分数约定为 0~1，越大越相关。
 *
 * 注意 `target` 决定了你需要哪一类模型：
 *   - "question" 比新问题和缓存里的旧问题 → 需要**句对/重复问题**训练的模型
 *   - "answer"   比新问题和缓存里的旧答案 → 正好是 query→passage，段落重排器适用
 */
export interface Reranker {
	score(query: string, candidate: string): Promise<number>;
}

export type EncoderRole = "pair" | "retrieval" | "rerank";
