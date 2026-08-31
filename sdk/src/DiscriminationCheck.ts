import { cosine } from "./VectorMath.ts";
import type { PairEncoder, Reranker, RetrievalEncoder } from "./types/Encoders.ts";

/**
 * 判别力自检。**上线前每个模型角色都要过这一关。**
 *
 * 任务错配不会报错：模型正常加载、返回合法的 0~1 分数、程序跑完，只是那个
 * 分数没有判别力。实测里两次都是这样 —— 段落重排器在中文上四组难度递减的
 * 输入全部落在 0.9975–0.9988（跨度 0.0013），句对模型做检索时正确文档排到
 * 三名开外。两次都毫无征兆。
 *
 * 做法：喂一组你已经知道答案的输入（必然该高分的、必然该低分的），看两组
 * 能不能分开。分不开就是任务错配，此时这一层的任何阈值标定都是在标定一个常数。
 */

export interface ProbePair {
	readonly label: string;
	readonly a: string;
	readonly b: string;
	/** true = 这一对**应当**得高分 */
	readonly shouldMatch: boolean;
}

export interface DiscriminationReport {
	readonly role: string;
	readonly rows: ReadonlyArray<{ label: string; score: number; shouldMatch: boolean }>;
	readonly minPositive: number;
	readonly maxNegative: number;
	/** 正例最低分 − 负例最高分。大于 0 才说明两组可分 */
	readonly margin: number;
	readonly spread: number;
	readonly usable: boolean;
}

function summarize(role: string, rows: Array<{ label: string; score: number; shouldMatch: boolean }>, minMargin: number): DiscriminationReport {
	const pos = rows.filter(r => r.shouldMatch).map(r => r.score);
	const neg = rows.filter(r => !r.shouldMatch).map(r => r.score);
	const minPositive = pos.length ? Math.min(...pos) : Number.NaN;
	const maxNegative = neg.length ? Math.max(...neg) : Number.NaN;
	const all = rows.map(r => r.score);
	const margin = minPositive - maxNegative;
	return {
		role,
		rows,
		minPositive,
		maxNegative,
		margin,
		spread: Math.max(...all) - Math.min(...all),
		usable: Number.isFinite(margin) && margin >= minMargin,
	};
}

export async function checkPairEncoder(
	encoder: PairEncoder,
	probes: ReadonlyArray<ProbePair>,
	minMargin = 0.05,
): Promise<DiscriminationReport> {
	const texts = probes.flatMap(p => [p.a, p.b]);
	const vectors = await encoder.embedQuestions(texts);
	const rows = probes.map((p, i) => ({
		label: p.label,
		score: cosine(vectors[i * 2], vectors[i * 2 + 1]),
		shouldMatch: p.shouldMatch,
	}));
	return summarize("pair", rows, minMargin);
}

export async function checkRetrievalEncoder(
	encoder: RetrievalEncoder,
	probes: ReadonlyArray<ProbePair>,
	minMargin = 0.02,
): Promise<DiscriminationReport> {
	const queries = await encoder.embedQuery(probes.map(p => p.a));
	const passages = await encoder.embedPassage(probes.map(p => p.b));
	const rows = probes.map((p, i) => ({
		label: p.label,
		score: cosine(queries[i], passages[i]),
		shouldMatch: p.shouldMatch,
	}));
	return summarize("retrieval", rows, minMargin);
}

export async function checkReranker(
	reranker: Reranker,
	probes: ReadonlyArray<ProbePair>,
	minMargin = 0.15,
): Promise<DiscriminationReport> {
	const rows: Array<{ label: string; score: number; shouldMatch: boolean }> = [];
	for (const p of probes) {
		rows.push({ label: p.label, score: await reranker.score(p.a, p.b), shouldMatch: p.shouldMatch });
	}
	return summarize("rerank", rows, minMargin);
}

/** CI 里用：分不开就抛，别让任务错配的模型上线。 */
export function assertDiscriminates(report: DiscriminationReport): void {
	if (report.usable) return;
	const detail = report.rows
		.map(r => `  ${r.shouldMatch ? "应高" : "应低"} ${r.score.toFixed(4)}  ${r.label}`)
		.join("\n");
	throw new Error(
		`模型角色「${report.role}」判别力不足：正例最低 ${report.minPositive.toFixed(4)}，` +
			`负例最高 ${report.maxNegative.toFixed(4)}，间隔 ${report.margin.toFixed(4)}。\n` +
			`多半是任务错配（例如拿段落重排器比问题↔问题，或拿句对模型做检索）。\n${detail}`,
	);
}
