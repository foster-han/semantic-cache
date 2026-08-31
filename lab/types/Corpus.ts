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
	/** 微调时追加的一句。同样跟着语料语言走。 */
	readonly refineSuffix: (title: string) => string;
}
