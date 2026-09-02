import type { ProbePair } from "../../sdk/src/index.ts";

/** 老师上传的一篇课程资料。`unit` 是章节/单元，参与检索时的章节加权。 */
export interface CourseDoc {
	readonly id: string;
	readonly course: string;
	readonly unit: string;
	readonly title: string;
	readonly version: number;
	readonly text: string;
}

/** 一次提问（验证台形状；翻译成 SDK 的 CachePrompt 在 LabCache 里做）。 */
export interface LabAsk {
	readonly text: string;
	readonly user?: string;
	/** 学生当前学到哪一章 —— 产品知道的上下文 */
	readonly unit?: string;
}

/**
 * 带标注的用例。
 *
 * **判据是 expectDoc（答案的首要依据），不是 expect（复用与否）。**
 * 有干扰缓存之后，命中另一条内容正确的缓存也是成功。
 */
export interface LabScenario {
	readonly key: string;
	readonly label: string;
	readonly note: string;
	/** 这条用例成立的前提，不成立时它测的就不是缓存 */
	readonly caveat?: string;
	readonly expectDoc: string;
	readonly seed: LabAsk;
	readonly probe: LabAsk;
	/** 仅供参考，不作判据 */
	readonly expect: "reuse" | "regenerate";
	/** 期望由哪道闸拦下 */
	readonly catches?: number | ReadonlyArray<number>;
	/** 播种与探测之间是否改版语料 */
	readonly bumpCorpus?: boolean;
}

/** 拼答案时用得到的片段字段。 */
export interface ComposeChunk {
	readonly title: string;
	readonly text: string;
	readonly version: number;
}

/**
 * ④ 的判别力探针。**必须跟着语料语言走** —— 一个英文训练的重排器在中文上饱和，
 * 而这件事只有用本语料的问句去问才看得出来。
 *
 * 用的是 SDK 的 `ProbePair`：`checkReranker` 要的就是这个形状，
 * 验证台不该为同一件事再造一套（先前那套 spread 判据比它弱，见 Server.ts）。
 */
export interface RerankProbe extends ProbePair {
	/**
	 * `b` 那一侧的答案该依据哪篇文档。
	 *
	 * **`target: "answer"` 的自检要拿它的答案当 candidate。** 探针必须跟着形态走，
	 * 不只跟着语料语言走：④ 比问↔答时，拿问↔问探针算出来的 margin 是另一个尺度上的数，
	 * 看着正常、算得出来，和 ④ 实际用的分数没有关系 —— 那正是「标定与实现同算子」
	 * 这条规矩在 ④ 上的同一个要求。
	 */
	readonly bDoc: string;
}

/** 一门课的完整语料包。中英文各一份，结构相同以便直接比较。 */
export interface CourseCorpus {
	readonly COURSE: string;
	readonly DOCS: ReadonlyArray<CourseDoc>;
	/** 大纲改版后的正文 */
	readonly SYL_V2: string;
	/** 匿名化实体表。个人数据不在这里 —— 那是路由 + 授权的事 */
	readonly ENTITIES: ReadonlyArray<string>;
	readonly STUDENT_RECORDS: Readonly<Record<string, string>>;
	/** 干扰缓存：让召回的 top-k 真的有东西可排 */
	readonly DISTRACTORS: ReadonlyArray<string>;
	readonly SCENARIOS: ReadonlyArray<LabScenario>;
	/** ④ 上线前的判别力探针：三组难度递减 + 一组逐字相同 */
	readonly RERANK_PROBES: ReadonlyArray<RerankProbe>;
	/**
	 * 把检索片段拼成答案。**住在语料包里，是因为模板语言必须跟着语料语言走。**
	 *
	 * 之前模板写死中文，英文语料下每条答案都是中英混合体，拿它和纯英文片段算余弦
	 * 会被系统性压低约 0.07 —— 压到连「答案 vs 它自己的来源」这个天花板都够不着
	 * θa高，于是英文语料下没有任何条目能走到直接复用。
	 *
	 * 标定脚本与运行路径引用**同一个函数**，标定与实现从此不可能分叉。
	 */
	readonly compose: (chunks: ReadonlyArray<ComposeChunk>) => string;
}
