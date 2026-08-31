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
	/** ④ 精排闸值（重排器自己的尺度）。`null` = 这个组合下没有有效标定 */
	readonly thetaQ: number | null;
	/** ⑥ 支撑度两档（检索模型 passage 空间，top-1 算子） */
	readonly thetaAHi: number;
	readonly thetaALo: number;
	readonly recallNote: string;
	readonly rerankNote: string;
	readonly supportNote: string;
}

/**
 * ③ 的下限不是判别阈值，是「像得够不够格进候选集」的地板，所以三种组合共用一句话。
 * 它没被探针标定过 —— 英文那轮 `calibrateCosine.ts` 的结论恰恰是纯余弦分不开近义反义
 * （margin −0.2936），说明这个尺度上不存在一个能同时管住两类错的值。取宽，让 ④/⑥ 去管。
 */
const RECALL_NOTE = "召回地板，未经探针标定：纯余弦分不开近义反义（英文实测 margin −0.2936），所以取宽，判别交给 ④/⑥";

/** 默认重排器 `ms-marco` 在中文上饱和（四组难度递减的输入落在 0.9975–0.9988，跨度 0.0013）。 */
const RERANK_SATURATED =
	"无有效标定：默认重排器 ms-marco 在中文上饱和（跨度 0.0013）。任何 θq 在这个分布上都不是阈值而是常数 —— 换 CE_MODEL= 成句对相似度模型后用 scripts/calibrate.ts 重标";

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
		thetaQ: null,
		thetaAHi: 0.973,
		thetaALo: 0.935,
		recallNote: RECALL_NOTE,
		rerankNote: RERANK_SATURATED,
		supportNote: `${ZH_LOCAL_SUPPORT}，stub 生成 1 次采样：该复用中位 0.9926 / 该拦下中位 0.9154 → margin 0.0772`,
	},
	{
		corpus: "zh",
		encoders: "local",
		generator: "claude-cli",
		recallFloor: 0.45,
		thetaQ: null,
		thetaAHi: 0.96,
		thetaALo: 0.926,
		recallNote: RECALL_NOTE,
		rerankNote: RERANK_SATURATED,
		supportNote: `${ZH_LOCAL_SUPPORT}，claude-cli 3 次采样取中位：0.9768 / 0.9096 → margin 0.0672（最坏 0.9732 vs 0.9407）`,
	},
	{
		corpus: "zh",
		encoders: "local",
		generator: "deepseek",
		recallFloor: 0.45,
		thetaQ: null,
		thetaAHi: 0.967,
		thetaALo: 0.936,
		recallNote: RECALL_NOTE,
		rerankNote: RERANK_SATURATED,
		supportNote: `${ZH_LOCAL_SUPPORT}，deepseek 5 次采样取中位：0.9831 / 0.9205 → margin 0.0626（最坏 0.9743 vs 0.9464）`,
	},
	{
		corpus: "en",
		encoders: "local",
		generator: "stub",
		recallFloor: 0.45,
		thetaQ: 0.979,
		thetaAHi: 0.923,
		thetaALo: 0.91,
		recallNote: RECALL_NOTE,
		rerankNote:
			"en 语料 · ms-marco · 探针中点 0.979（margin +0.0344，勉强可分）。**任务仍然错配**：端到端零精度收益、砍掉 2 次合法复用，见 FINDINGS",
		supportNote: "en 语料 · e5-small passage 空间 · top-1 算子 · stub 生成 · scripts/calibrate.ts",
	},
	{
		corpus: "zh",
		encoders: "stub",
		generator: "stub",
		recallFloor: 0.45,
		thetaQ: null,
		thetaAHi: 0.97,
		thetaALo: 0.96,
		recallNote: STUB_ENCODER_NOTE,
		rerankNote: "stub 编码器没有重排器 —— ④ 这道闸不存在",
		supportNote: STUB_ENCODER_NOTE,
	},
	{
		corpus: "en",
		encoders: "stub",
		generator: "stub",
		recallFloor: 0.45,
		thetaQ: null,
		thetaAHi: 0.97,
		thetaALo: 0.96,
		recallNote: STUB_ENCODER_NOTE,
		rerankNote: "stub 编码器没有重排器 —— ④ 这道闸不存在",
		supportNote: STUB_ENCODER_NOTE,
	},
];

export interface CalibrationTarget {
	readonly corpus: CorpusLanguage;
	readonly encoders: EncoderMode;
	readonly generator: GeneratorKind;
}

export interface ActiveCalibration {
	readonly recallFloor: number;
	readonly thetaQ: number | null;
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

	return {
		recallFloor: (overrides.recallFloor as number | undefined) ?? borrowedRow.recallFloor,
		thetaQ: overrides.thetaQ === undefined ? borrowedRow.thetaQ : overrides.thetaQ,
		thetaAHi: (overrides.thetaAHi as number | undefined) ?? borrowedRow.thetaAHi,
		thetaALo: (overrides.thetaALo as number | undefined) ?? borrowedRow.thetaALo,
		recallNote: `${borrowedRow.recallNote}${suffix}`,
		rerankNote: `${borrowedRow.rerankNote}${suffix}`,
		supportNote: `${borrowedRow.supportNote}${suffix}`,
		summary:
			`标定：${label(target)}${exact ? "" : "（借用）"}　` +
			`③ ${(overrides.recallFloor as number | undefined) ?? borrowedRow.recallFloor}　` +
			`④ ${(overrides.thetaQ === undefined ? borrowedRow.thetaQ : overrides.thetaQ) ?? "无（这道闸默认关）"}　` +
			`⑥ ${(overrides.thetaAHi as number | undefined) ?? borrowedRow.thetaAHi} / ${(overrides.thetaALo as number | undefined) ?? borrowedRow.thetaALo}` +
			(notes.length === 0 ? "" : `\n${notes.join("\n")}`),
		borrowed: exact === undefined,
		overridden,
	};
}
