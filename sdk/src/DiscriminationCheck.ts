import { cosine } from "./VectorMath.ts";
import type { PairEncoder, Reranker } from "./types/Encoders.ts";

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


/**
 * 从一批探针的分数里，选出一个闸值。
 *
 * **这是「阈值必须在你自己的数据上标」在没有标注数据时唯一可行的那条路。**
 * 行业通行做法是从生产日志抽 100–500 条人工标注 —— 那假设的是单一语料、单一部署，
 * 且那份语料稳定到值得请人标一遍。语料由终端用户上传、且一批一个样的时候，
 * 这两条都不成立：没有可标的历史日志，也没有「一次标完管很久」的那个前提。
 * 可用的只有一件事：**语料本身就在手上**，`generateProbes()` 从它自动造出正负例，
 * 这个函数把那批分数变成一个数。
 *
 * **标定的单位因此是「一批探针」，不是「一次部署」。** 这批探针对应哪一批语料、
 * 多久重跑一次、要不要按批分别建缓存实例 —— 全是调用方的业务决定，库不认识那个粒度，
 * 它只认这批分数和你给的 `corpus` 标签（标签会原样写进 `calibratedOn`）。
 *
 * **判据照搬 `FINDINGS.md` 的口径**：在正命中率 ≥ `targetPrecision` 的前提下，
 * 取命中率最高的那个 θ。不是取 margin 中点 —— 那只在两组完全分得开时才有定义，
 * 而真实语料上「L1 正则化 / L2 正则化」这类难负例本来就会和正例重叠。
 *
 *   正命中率 = 判为命中的里面有多少真该命中（假命中的反面，贵的那一侧）
 *   命中率   = 真该命中的里面有多少判出来了（漏掉的只是白花一次生成，便宜）
 *
 * **给不出 θ 时返回 `threshold: null`，并且 `calibratedOn` 是空串。** 后者是有意的：
 * 空串填进 `Calibrated` 会在构造期抛，所以一次失败的标定不可能被顺手带上线 ——
 * 拿不到能用的东西，比拿到一个看着像数的数安全。这时该做的是退回 ② 精确匹配
 * （零假命中风险），或者开影子模式攒够真实流量再说。
 */
export interface ThresholdSuggestion {
	/** 建议的闸值。给不出时是 null，理由在 `reason` 里 */
	readonly threshold: number | null;
	/** 这个 θ 在**这批探针**上的正命中率。给不出 θ 时是 0 */
	readonly precision: number;
	/** 这个 θ 在**这批探针**上的命中率。给不出 θ 时是 0 */
	readonly recall: number;
	readonly positives: number;
	readonly negatives: number;
	/**
	 * 把 θ 顶住的那条负例 —— 分数最高的那一对，也就是这批语料里最难的一对。
	 *
	 * 报出来是因为它可读：`同章不同概念 · L1 正则化 ／ L2 正则化` 一眼就能看出
	 * 这门课难在哪，而「θ 只能取到 0.93」看不出。达不到目标正命中率时，它就是原因。
	 */
	readonly hardestNegative: { readonly label: string; readonly score: number } | null;
	/** 给不出 θ 的原因；给得出时是 null */
	readonly reason: string | null;
	/** 直接填进 `Calibrated.calibratedOn`。给不出 θ 时是空串（填进去会抛） */
	readonly calibratedOn: string;
}

export interface ThresholdSuggestionOptions {
	/**
	 * 这批探针来自哪，原样写进 `calibratedOn`。语料的标识由业务定 ——
	 * 租户 + 知识库版本、课程 + 学期、一次导入的批次号，库不解释它的内容。
	 *
	 * 必填且不能是空串，和 `Calibrated.calibratedOn` 同一条规矩：一个不知道
	 * 在什么语料上标出来的阈值，半年后没人敢动它，也没人说得清它还成不成立。
	 */
	readonly corpus: string;
	/**
	 * 目标正命中率，默认 0.95 —— 行业惯例（precision ≥ 95% 再放量）。
	 *
	 * 这里给默认值不违反「阈值没有默认值」那条：默认的是**取舍**（假命中比漏命中贵
	 * 多少），不是阈值本身。θ 仍然完全由这批语料的分数决定，而且取舍值会写进
	 * `calibratedOn`，事后看得见。
	 */
	readonly targetPrecision?: number;
}

/** 见 `ThresholdSuggestion`。 */
export function suggestThreshold(report: DiscriminationReport, options: ThresholdSuggestionOptions): ThresholdSuggestion {
	const corpus = options.corpus;
	if (typeof corpus !== "string" || corpus.trim() === "") {
		throw new Error(
			"suggestThreshold 需要 corpus：这批探针来自哪门课、哪个学期、哪一版资料。" +
				"它会写进 calibratedOn —— 一个不知道在什么语料上标出来的阈值，等于没标。",
		);
	}
	const target = options.targetPrecision ?? 0.95;
	if (!Number.isFinite(target) || target <= 0 || target > 1) {
		throw new Error(`targetPrecision 必须落在 (0, 1]，收到 ${String(options.targetPrecision)}。`);
	}

	const positives = report.rows.filter(r => r.shouldMatch);
	const negatives = report.rows.filter(r => !r.shouldMatch);
	const hardest = negatives.reduce<{ label: string; score: number } | null>(
		(worst, r) => (worst === null || r.score > worst.score ? { label: r.label, score: r.score } : worst),
		null,
	);
	const head = { positives: positives.length, negatives: negatives.length, hardestNegative: hardest };
	const nothing = { threshold: null, precision: 0, recall: 0, calibratedOn: "", ...head };

	/**
	 * 两侧缺一不可，而且缺的那侧后果不同：
	 * 没有负例 → 量不出假命中，θ 会被取到不能再松；没有正例 → 量不出合法复用被误拒。
	 * 后者正是「没接 phrasing 就一条正例都造不出来」的那种情况，产品里最常见。
	 */
	if (positives.length === 0) {
		return { ...nothing, reason: "一条正例都没有：这批探针只能界定假命中，量不出「该命中的漏了多少」，任何 θ 都是在猜命中率。给 generateProbes 接上 phrasing，或者用老师提供的问法。" };
	}
	if (negatives.length === 0) {
		return { ...nothing, reason: "一条负例都没有：量不出假命中，而假命中正是这个阈值要挡的东西。" };
	}

	/**
	 * 候选 θ 只取**观测到的分数**。在两个观测值之间取值不会改变这批探针上的任何判定，
	 * 却会让报出来的正命中率显得比证据更精确 —— 唯一的例外是下面那段完全可分的情形。
	 */
	let best: { threshold: number; precision: number; recall: number } | null = null;
	for (const theta of [...new Set(report.rows.map(r => r.score))].sort((a, b) => a - b)) {
		const tp = positives.filter(r => r.score >= theta).length;
		const fp = negatives.filter(r => r.score >= theta).length;
		if (tp === 0) continue; // 一条正例都留不住的 θ 不是候选，哪怕它正命中率是满分
		const precision = tp / (tp + fp);
		if (precision < target) continue;
		const recall = tp / positives.length;
		// 命中率优先；同命中率取更高的 θ —— 同样多的复用，假命中更少或持平
		if (best === null || recall > best.recall || (recall === best.recall && theta > best.threshold)) {
			best = { threshold: theta, precision, recall };
		}
	}

	if (best === null) {
		return {
			...nothing,
			reason:
				`这批探针上达不到 ${(target * 100).toFixed(0)}% 的正命中率` +
				(hardest === null ? "。" : `：最难的一对负例「${hardest.label}」得了 ${hardest.score.toFixed(4)}，压过了太多正例。`) +
				"要么换一个在这门课上分得开的打分器，要么这门课退回 ② 精确匹配（零假命中风险），" +
				"或者先开影子模式攒真实流量 —— 不要拿一个别处搬来的数上线。",
		};
	}

	/**
	 * 完全分得开时，把 θ 挪到空隙中点。
	 *
	 * 这批探针上判定完全不变（空隙里一个分数都没有），但两侧各留一半余量：探针只有
	 * 几十条，而真实流量迟早会把空隙填上一些 —— 贴着 `minPositive` 放，第一条比它
	 * 略低的合法改写就掉出去了。
	 */
	const separable = report.margin > 0 && best.threshold === report.minPositive;
	const threshold = separable ? (report.maxNegative + report.minPositive) / 2 : best.threshold;

	return {
		...head,
		threshold,
		precision: best.precision,
		recall: best.recall,
		reason: null,
		calibratedOn:
			`${corpus} · ${report.rows.length} 条自动探针（正 ${positives.length} / 负 ${negatives.length}）· ` +
			`${report.role} 打分器 · θ=${threshold.toFixed(4)}（目标正命中率 ${(target * 100).toFixed(0)}%，` +
			`实测正命中率 ${(best.precision * 100).toFixed(1)}% / 命中率 ${(best.recall * 100).toFixed(1)}%）`,
	};
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
