import type { ProbePair } from "../DiscriminationCheck.ts";

/**
 * 从上传的课程资料自动生成判别力探针。
 *
 * **为什么需要这个：手写探针在产品里不成立。**验证台的 `RERANK_PROBES` 是照着一门课
 * 手写的，而真实场景里老师传什么、学生问什么都事先不知道。没有探针就没有标定，
 * 没有标定 `calibratedOn` 就是空话 —— 那正是这套类型设计要防的东西。
 *
 * 可做的事只有一件：**资料上传的那一刻，语料就已经在手上了。**从它构造出「必然该
 * 复用」和「必然该拦下」两组，不需要等任何学生流量。
 */

/**
 * 一篇上传的资料，探针生成只需要这么多。
 *
 * **不收正文。**构造问句要的是概念（`title`）和它在哪一章（`unit`），正文只会
 * 把这里变成第二个检索实现。要用正文做改写，在 `QuestionPhrasing` 那一侧读。
 */
export interface ProbeSource {
	readonly id: string;
	/**
	 * 章节 / 单元。**它决定负例的难度，不是元数据。**
	 *
	 * 同一单元里的两个概念（`L1 正则化` 与 `L2 正则化`）词汇高度重叠、意思不同 ——
	 * 这正是双编码器分不开、必须靠 ④ 的那一类。跨单元的两个概念则是容易负例。
	 * 两档混在一起标出来的阈值，会被容易的那批拉松。
	 */
	readonly unit: string;
	/** 这篇资料讲的概念，用来构成学生会问的那句话 */
	readonly title: string;
	/**
	 * 这个概念已知的几种问法。**给了两条以上才能造正例。**
	 *
	 * 来源可以是老师写的 FAQ、历史提问日志，或 `QuestionPhrasing` 现生成的。
	 * 留空则退回用 `title` 当问句 —— 那只够造负例，见 `ProbeGenerationReport.warnings`。
	 */
	readonly questions?: ReadonlyArray<string>;
}

/**
 * 把一个概念变成学生会问的若干种问法。
 *
 * **产品里已经有 LLM 了，这里就是把它接进来。**和 `Generate` 一样由调用方传入：
 * 这一层不挑生成端，也不内置问句模板 —— 模板造出来的「不同问法」在字面上几乎相同，
 * 任何编码器都能过，标出来的 margin 是假的宽。宁可没有正例，也不要假正例。
 */
export type QuestionPhrasing = (
	concept: string,
	count: number,
	source: ProbeSource,
) => Promise<ReadonlyArray<string>>;

/**
 * 探针难度档。**顺序就是难度递减，这个次序有意义。**
 *
 * 报告按档给出，是因为「整体可分」会骗人：容易负例把 margin 撑开，而真正会造成
 * 假命中的是 `sibling` 那一档。只看总 margin 会漏掉这件事。
 */
export type ProbeTier =
	/** 正例 · 逐字相同。天花板检查 —— 这一档都分不出，说明模型或 pooling 配错了 */
	| "identical"
	/** 正例 · 同一概念的不同问法 */
	| "paraphrase"
	/** 负例 · 同一单元内的不同概念。**难负例，这个场景真正的危险来源** */
	| "sibling"
	/** 负例 · 跨单元的不同概念。容易负例 */
	| "distant";

export interface GeneratedProbe extends ProbePair {
	readonly tier: ProbeTier;
	readonly aDoc: string;
	/**
	 * `b` 那一侧该依据哪篇资料。
	 *
	 * ④ 自检跑 `target: "answer"` 时要拿这篇的答案当 candidate —— 探针必须跟着
	 * 形态走，拿问↔问的探针去标问↔答的闸，算得出来但不是同一个尺度。
	 */
	readonly bDoc: string;
}

export interface ProbeGenerationOptions {
	/** 没有它、`ProbeSource.questions` 也没给两条以上时，正例一条都造不出来 */
	readonly phrasing?: QuestionPhrasing;
	/** 每个概念取几种问法。默认 2 —— 造一对正例的最小值 */
	readonly phrasingsPerConcept?: number;
	/**
	 * 每档最多几对。默认偏向 `sibling`：一门课的资料两两配对是 O(n²)，
	 * 全要既跑不完也没必要，而难负例才是这个场景该多测的那一档。
	 */
	readonly limits?: Partial<Record<ProbeTier, number>>;
}

export interface ProbeGenerationReport {
	readonly probes: ReadonlyArray<GeneratedProbe>;
	readonly counts: Readonly<Record<ProbeTier, number>>;
	/**
	 * 这组探针能检出什么。**两边都为 true 才能拿去标阈值。**
	 *
	 * 只有负例时，能检出「负例分不开」（假命中的来源），检不出「正例被误拒」
	 * （命中率白掉的来源）。拿这种探针标出来的闸只会越标越严。
	 */
	readonly usableFor: {
		readonly negatives: boolean;
		readonly positives: boolean;
	};
	/**
	 * 直接可以填进 `Calibrated.calibratedOn` 的一句话。
	 *
	 * 这个字段是必填的，而人手写的那句话半年后一定对不上 —— 由生成方给出，
	 * 才能保证「这组阈值标在什么上面」和实际用的探针不分叉。
	 */
	readonly calibratedOn: string;
	/** 这组探针哪里不结实。空数组才意味着没有已知问题 */
	readonly warnings: ReadonlyArray<string>;
}
