/**
 * 标定表。
 *
 * **一份跨语料、跨编码器、跨生成端通用的阈值是不存在的** —— 这套东西自己的结论就是
 * 「阈值属于打分器、属于生成端、属于语料」。先前 lab 里只有一份硬编码的 DEFAULTS，
 * 于是 FINDINGS 里英文那一轮（θq 0.979 / θa 0.923 / 0.910）从干净 checkout 跑不出来：
 * 只能改源码。这张表就是把那句「可复现」变成真的。
 *
 * 每一行的数都来自 `scripts/calibrate.ts` 在那个组合上跑出来的输出，`note` 写明是
 * 哪一轮。**没有标定过的组合不会假装有** —— 借用最近的一行，并在 `calibratedOn` 里
 * 说清楚借的是谁，这样 trace 和页面上看到的就是实话。
 */
import type { RerankTarget } from "../sdk/src/index.ts";
import type { GeneratorKind } from "./Generators.ts";

export type CorpusLanguage = "zh" | "en";
export type EncoderMode = "stub" | "local";

export interface CalibrationRow {
	readonly corpus: CorpusLanguage;
	readonly encoders: EncoderMode;
	/** 生成端的 kind。真生成端各标一行 —— 答案是它写的，支撑度的分布就跟着它走 */
	readonly generator: GeneratorKind;
	/** ③ 召回下限（句对模型的余弦尺度） */
	readonly recallFloor: number;
	/** ⑥ 支撑度两档（检索模型 passage 空间，top-1 算子） */
	readonly thetaAHi: number;
	readonly thetaALo: number;
	readonly recallNote: string;
	readonly supportNote: string;
}

/**
 * ④ 的标定**单独一张表，因为它的键不是 (语料 × 编码器 × 生成端)**。
 *
 * θq 属于 (重排模型 × 形态)：同一个 `bge-reranker-base`，问↔问的最优闸值是 0.1228、
 * 问↔答是 0.3494。这两个数塞进主表就会出现「同一行两个 θq」的歧义，而先前主表里
 * 那个单一 `thetaQ` 字段其实隐含了「θq 只跟语料走」的假设 —— 那是错的。
 *
 * `generator` 只在 `target: "answer"` 下有意义：那时 candidate 是生成端写的答案，
 * 分布跟着它走。`target: "question"` 下比的是两个问句，与生成端无关，填 `null`。
 */
export interface RerankCalibrationRow {
	readonly corpus: CorpusLanguage;
	/** HF 模型 id，对应 `CE_MODEL=` */
	readonly model: string;
	/** 对应 `CE_TARGET=` */
	readonly target: RerankTarget;
	/** `null` = 对所有生成端通用（只可能出现在 target: "question" 上） */
	readonly generator: GeneratorKind | null;
	readonly thetaQ: number;
	readonly note: string;
}

/**
 * ③ 的下限不是判别阈值，是「像得够不够格进候选集」的地板，所以三种组合共用一句话。
 * 它没被探针标定过 —— 英文那轮 `calibrateCosine.ts` 的结论恰恰是纯余弦分不开近义反义
 * （margin −0.2936），说明这个尺度上不存在一个能同时管住两类错的值。取宽，让 ④/⑥ 去管。
 */
const RECALL_NOTE = "召回地板，未经探针标定：纯余弦分不开近义反义（英文实测 margin −0.2936），所以取宽，判别交给 ④/⑥";

/**
 * ④ 标定表。**没标定过的 (模型 × 形态) 组合查不到就是查不到**，不借用 ——
 * 借一个别的模型的 θq 就是尺度混用，那正是这套类型设计一路在防的事。
 *
 * 缺席也是信息：`ms-marco × zh` 两种形态都不在表里，因为它在中文上饱和
 * （18 对真实对子，问↔问 margin −0.0003）。所以中文默认没有 ④ —— 这是对的，
 * 一个恒放行的假闸比没有闸更糟：页面上看着在工作，而「④ 值不值」那张对照卡
 * 会永远输出「两边一模一样」，把任务错配误读成「这道闸没用」。
 */
export const RERANK_CALIBRATIONS: ReadonlyArray<RerankCalibrationRow> = [
	{
		corpus: "zh",
		model: "Xenova/bge-reranker-base",
		target: "answer",
		generator: "stub",
		thetaQ: 0.3494,
		note:
			"zh · bge-reranker-base · 问↔答 · 18 对真实语料对子（9 同义改写 + 9 近义反义，含 2 对同篇负例）· " +
			"lab/_probe_ce6.ts 量分数、_probe_ce7.ts 量这个数有多可信。**0.3494 不是测出来的最优值，是按代价不对称选的平台端点**：" +
			"错误最少（4/18）对应的 θ 平台是 0.3494~0.9720（宽 0.62，因为分数极端双峰、中间是空的），" +
			"bootstrap 95% 区间 0.287~0.999 —— 这份数据定不出 θq 的位置，只定出它落在一个很宽的空隙里。" +
			"取下界而不是中点 0.6607，因为 ④ 的假正后面还有 ⑤⑥ 接着，而假负是净损失（那正是「④ 砍掉 2 次合法复用」那条负收益的成因）。" +
			"泛化误差看留一交叉验证：27.8%，不是训练误差那个 22.2%。**这一行只对拼接式生成成立**：" +
			"candidate 是 compose() 拼的答案，换真生成端要重标",
	},
	{
		corpus: "zh",
		model: "Xenova/bge-reranker-base",
		target: "question",
		generator: null,
		thetaQ: 0.1228,
		note:
			"zh · bge-reranker-base · 问↔问 · 同 18 对 · lab/_probe_ce6.ts + _probe_ce7.ts：训练误差 6/18，" +
			"而**留一交叉验证 9/18 = 50%，等于抛硬币**；bootstrap 95% 区间 0.0000~0.9987。" +
			"也就是说这个尺度上不存在可用阈值，0.1228 同样只是平台（0.1228~0.9433）的端点。" +
			"**留在表里是为了对照，不是推荐**：bge 是 query→passage 训练的，用它比问句是任务错配的那一支。" +
			"值得注意的是**形态之间的比较比任一个 θq 的绝对值稳健得多** —— 留一下 27.8%（问↔答）对 50%（问↔问），" +
			"差距比训练误差那组（22% 对 33%）还大。配对比较（同一批对子、同一个模型）本来就比绝对阈值稳",
	},
	{
		corpus: "en",
		model: "Xenova/ms-marco-MiniLM-L-6-v2",
		target: "question",
		generator: null,
		thetaQ: 0.979,
		note:
			"en · ms-marco · 问↔问 · 探针中点 0.979（margin +0.0344，勉强可分）。**任务仍然错配**：" +
			"端到端零精度收益、砍掉 2 次合法复用，见 FINDINGS。" +
			"**这一行 n=5，且没做过平台/留一分析** —— 中文那两行做完之后才知道 n=18 都定不出 θq 的位置，" +
			"n=5 只会更糟，别把 0.979 当成一个有三位有效数字的量。en × bge 的问↔答形态还没标 —— " +
			"探针层面 bge 的英文 margin 是 +0.7925，值得连平台一起标一行",
	},
];

const STUB_ENCODER_NOTE =
	"stub 编码器：分数是字符 Jaccard 的哈希投影，没有统计意义。这一行只为让控制流跑得通，别拿它的 bench 数字说事";

/**
 * zh × local 的三行来自 FINDINGS「三个生成端，同一套标定方法」那张表
 * （10 条标定用例，每条采样 N 次取中位数，e5-small 的 passage 空间）。
 */
const ZH_LOCAL_SUPPORT = "zh 语料 · e5-small passage 空间 · top-1 算子 · scripts/calibrate.ts";

export const CALIBRATIONS: ReadonlyArray<CalibrationRow> = [
	{
		corpus: "zh",
		encoders: "local",
		generator: "stub",
		recallFloor: 0.45,
		thetaAHi: 0.973,
		thetaALo: 0.935,
		recallNote: RECALL_NOTE,
		supportNote: `${ZH_LOCAL_SUPPORT}，stub 生成 1 次采样：该复用中位 0.9926 / 该拦下中位 0.9154 → margin 0.0772`,
	},
	{
		corpus: "zh",
		encoders: "local",
		generator: "claude-cli",
		recallFloor: 0.45,
		thetaAHi: 0.96,
		thetaALo: 0.926,
		recallNote: RECALL_NOTE,
		supportNote: `${ZH_LOCAL_SUPPORT}，claude-cli 3 次采样取中位：0.9768 / 0.9096 → margin 0.0672（最坏 0.9732 vs 0.9407）`,
	},
	{
		corpus: "zh",
		encoders: "local",
		generator: "deepseek",
		recallFloor: 0.45,
		thetaAHi: 0.967,
		thetaALo: 0.936,
		recallNote: RECALL_NOTE,
		supportNote: `${ZH_LOCAL_SUPPORT}，deepseek 5 次采样取中位：0.9831 / 0.9205 → margin 0.0626（最坏 0.9743 vs 0.9464）`,
	},
	{
		corpus: "en",
		encoders: "local",
		generator: "stub",
		recallFloor: 0.45,
		thetaAHi: 0.923,
		thetaALo: 0.91,
		recallNote: RECALL_NOTE,
		supportNote: "en 语料 · e5-small passage 空间 · top-1 算子 · stub 生成 · scripts/calibrate.ts",
	},
	{
		corpus: "zh",
		encoders: "stub",
		generator: "stub",
		recallFloor: 0.45,
		thetaAHi: 0.97,
		thetaALo: 0.96,
		recallNote: STUB_ENCODER_NOTE,
		supportNote: STUB_ENCODER_NOTE,
	},
	{
		corpus: "en",
		encoders: "stub",
		generator: "stub",
		recallFloor: 0.45,
		thetaAHi: 0.97,
		thetaALo: 0.96,
		recallNote: STUB_ENCODER_NOTE,
		supportNote: STUB_ENCODER_NOTE,
	},
];

export interface CalibrationTarget {
	readonly corpus: CorpusLanguage;
	readonly encoders: EncoderMode;
	readonly generator: GeneratorKind;
	/** 实际加载到的重排模型 id；`null` = 没加载到，那就没有 ④ 这道闸 */
	readonly rerankModel: string | null;
	/** ④ 把旧问题还是旧答案递给重排器（`CE_TARGET=`） */
	readonly rerankTarget: RerankTarget;
}

export interface ActiveCalibration {
	readonly recallFloor: number;
	readonly thetaQ: number | null;
	/** ④ 的形态 —— θq 只在这个形态下有意义，页面和 trace 要一起显示 */
	readonly rerankTarget: RerankTarget;
	readonly thetaAHi: number;
	readonly thetaALo: number;
	/** 三个 stage 各自的 `calibratedOn` —— 它们标定于不同的东西，不该共用一句话 */
	readonly recallNote: string;
	readonly rerankNote: string;
	readonly supportNote: string;
	/** 一行摘要，给启动日志和页面横幅 */
	readonly summary: string;
	/** 没有这个组合的行，借了别人的 */
	readonly borrowed: boolean;
	/** 被环境变量覆盖掉的字段名 */
	readonly overridden: ReadonlyArray<string>;
}

function label(target: CalibrationTarget): string {
	return `${target.corpus} × ${target.encoders} 编码器 × ${target.generator} 生成`;
}

/** `THETA_Q=none` 显式表示「这个组合下没有 θq」，和「没设这个变量」不是一回事。 */
function readOverride(name: string, nullable: boolean): number | null | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	if (nullable && (raw === "none" || raw === "null")) return null;
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new Error(`${name}=${raw} 不是有限数。${nullable ? "要表示「没有这道闸」请用 none。" : ""}`);
	}
	return value;
}

/**
 * 选出这次运行该用的那一组阈值。
 *
 * 借用规则只有两条，按顺序：**先借同语料同编码器的另一个真生成端**（依据是那条
 * 「真生成 vs 拼接是主因、哪家模型是次因」的假设 —— 它还没立住，所以借了要说），
 * 再退到 stub 生成那一行（分布会整体偏高，θa 因此偏紧）。
 */
export function resolveCalibration(target: CalibrationTarget): ActiveCalibration {
	const exact = CALIBRATIONS.find(
		r => r.corpus === target.corpus && r.encoders === target.encoders && r.generator === target.generator,
	);
	const sameStack = CALIBRATIONS.filter(r => r.corpus === target.corpus && r.encoders === target.encoders);
	const borrowedRow = exact ?? sameStack.find(r => r.generator !== "stub") ?? sameStack[0];
	if (!borrowedRow) {
		throw new Error(`标定表里没有 ${label(target)} 可用的行。补一行到 lab/Calibrations.ts，或用 THETA_* 环境变量覆盖。`);
	}

	const borrowNote = exact
		? ""
		: `⚠ 借用「${borrowedRow.corpus} × ${borrowedRow.encoders} × ${borrowedRow.generator}」那一行 —— ` +
			`${label(target)} 没标定过。真生成端之间借用的依据是那条尚未立住的假设（阈值按「真生成/拼接」分而非按厂商分）；` +
			`借 stub 生成的行则会偏紧，因为拼接答案的支撑度天然偏高。要立住就跑 scripts/calibrate.ts 补一行`;

	/**
	 * ④ 单独查它自己那张表，**查不到就是没有这道闸** —— 不借用别的模型或别的形态的 θq。
	 *
	 * 三种「没有」要分开说，否则页面上看到的都是「④ 关着」而原因完全不同：
	 * 没加载到模型、这个 (模型 × 形态) 没标定过、stub 编码器根本没有重排器。
	 */
	const rerankRow = RERANK_CALIBRATIONS.find(
		r =>
			r.corpus === target.corpus &&
			r.model === target.rerankModel &&
			r.target === target.rerankTarget &&
			(r.generator === null || r.generator === target.generator),
	);
	const rerankNote =
		target.encoders === "stub"
			? "stub 编码器没有重排器 —— ④ 这道闸不存在"
			: target.rerankModel === null
				? "没加载到重排器 —— ④ 这道闸不存在（不会退化成拿 θq 去卡召回余弦）"
				: rerankRow
					? rerankRow.note
					: `无有效标定：(${target.rerankModel} × ${target.rerankTarget === "answer" ? "问↔答" : "问↔问"}) 这个组合在 ${target.corpus} 语料上没标定过。` +
						"④ 因此是关的。出路：用 lab/_probe_ce6.ts 量一下这个组合分不分得开，分得开就补一行到 RERANK_CALIBRATIONS，" +
						"或显式 THETA_Q= 一个值（那就由你自己为它负责）";

	const overrides = {
		recallFloor: readOverride("RECALL_FLOOR", false),
		thetaQ: readOverride("THETA_Q", true),
		thetaAHi: readOverride("THETA_A_HI", false),
		thetaALo: readOverride("THETA_A_LO", false),
	};
	const overridden = Object.entries(overrides)
		.filter(([, v]) => v !== undefined)
		.map(([k]) => k);
	const overrideNote = overridden.length === 0 ? "" : `⚠ 被环境变量覆盖：${overridden.join("、")} —— 这组数已经不是表里那一行`;

	const notes = [borrowNote, overrideNote].filter(n => n !== "");
	const suffix = notes.length === 0 ? "" : `；${notes.join("；")}`;

	const thetaQ = overrides.thetaQ === undefined ? (rerankRow?.thetaQ ?? null) : overrides.thetaQ;
	const formLabel = target.rerankTarget === "answer" ? "问↔答" : "问↔问";

	return {
		recallFloor: (overrides.recallFloor as number | undefined) ?? borrowedRow.recallFloor,
		thetaQ,
		rerankTarget: target.rerankTarget,
		thetaAHi: (overrides.thetaAHi as number | undefined) ?? borrowedRow.thetaAHi,
		thetaALo: (overrides.thetaALo as number | undefined) ?? borrowedRow.thetaALo,
		recallNote: `${borrowedRow.recallNote}${suffix}`,
		// ④ 的 note 不带 suffix：借用与覆盖说的是主表那三个阈值，θq 走的是自己那张表
		rerankNote: overridden.includes("thetaQ") ? `${rerankNote}；⚠ θq 被 THETA_Q= 覆盖，已不是表里的数` : rerankNote,
		supportNote: `${borrowedRow.supportNote}${suffix}`,
		summary:
			`标定：${label(target)}${exact ? "" : "（借用）"}　` +
			`③ ${(overrides.recallFloor as number | undefined) ?? borrowedRow.recallFloor}　` +
			`④ ${thetaQ === null ? "无（这道闸关着）" : `${thetaQ}（${formLabel}）`}　` +
			`⑥ ${(overrides.thetaAHi as number | undefined) ?? borrowedRow.thetaAHi} / ${(overrides.thetaALo as number | undefined) ?? borrowedRow.thetaALo}` +
			(notes.length === 0 ? "" : `\n${notes.join("\n")}`),
		borrowed: exact === undefined,
		overridden,
	};
}
