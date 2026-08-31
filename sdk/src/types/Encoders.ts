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
 * ④ 把**什么**递给重排器当 candidate。它决定了你需要哪一类模型，也决定了分数尺度。
 *
 * - `"question"` 新问题 ↔ 缓存里的旧问题 → 需要**句对/重复问题**训练的模型
 * - `"answer"`   新问题 ↔ 缓存里的旧答案 → 正好是 query→passage，段落重排器适用
 *
 * **这不是二选一的口味问题，是实测差别。** 同 18 对中文语料对子、同一个
 * `bge-reranker-base`（query→passage 训练），只换形态：
 *
 * | 形态 | 留一交叉验证 | 训练误差 | 假负（砍掉合法复用） |
 * |---|---|---|---|
 * | `"question"` | 50.0%（等于抛硬币） | 6/18 | 1 |
 * | `"answer"`   | **27.8%** | 4/18 | **0** |
 *
 * 假负归零是关键：那条「④ 开着零精度收益、还砍掉 2 次合法复用」的负收益结论，
 * 成因就是假负。措辞完全不重叠的同义改写（`集成方法是什么？`／`为什么把多个模型
 * 合起来会更好？`）在 `"question"` 下得 0.0001，在 `"answer"` 下得 0.5573。
 *
 * **两列都给，是因为它们说的不是一件事。**训练误差那一列的阈值是在同一份数据上选的，
 * 偏乐观；留一那一列才是泛化估计。而**形态之间的比较比任一个阈值的绝对值稳健得多** ——
 * 它是同批对子、同模型、只换 candidate 的配对比较，不需要定出阈值的位置。
 * 那个位置这份数据反而定不出来（n=18 上平台宽 0.62，bootstrap 95% 区间 0.287~0.999）。
 * 所以：形态该选 `"answer"`，但**你自己的 floor 必须在你自己的数据上标**。
 *
 * 反过来也成立：把 NLI 模型从 `"question"` 换到 `"answer"` 会直接塌掉
 * （假负 5/9，中位 margin 转负）—— 短问句蕴含长答案文本，方向本就不成立。
 * **换形态和换模型一样是任务错配的来源，所以两者都要连 θq 一起重标。**
 */
export type RerankTarget = "question" | "answer";

/** 精排。分数约定为 0~1，越大越相关。递进来的 candidate 由 `RerankTarget` 决定。 */
export interface Reranker {
	score(query: string, candidate: string): Promise<number>;
}

export type EncoderRole = "pair" | "retrieval" | "rerank";
