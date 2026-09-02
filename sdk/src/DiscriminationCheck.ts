import type { PairEncoder, Reranker } from "./types/Encoders.ts";
import { cosine } from "./VectorMath.ts";

/**
 * Discrimination self-check. **Every model role must pass this before going live.**
 *
 * Misapplying a model raises no error: it loads, returns legitimate 0–1 scores, and the program
 * runs to completion — the scores simply have no discriminating power. Both measured cases looked
 * like that: a passage reranker on Chinese put four sets of decreasing difficulty all between
 * 0.9975 and 0.9988 (a spread of 0.0013), and a sentence-pair model used for retrieval ranked the
 * correct document outside the top three. Neither gave any warning.
 *
 * The method: feed in inputs whose answers you already know (some that must score high, some that
 * must score low) and see whether the two groups separate. If they do not, the model is
 * misapplied, and any threshold calibration on this layer is calibrating a constant.
 */

export interface ProbePair {
	readonly label: string;
	readonly a: string;
	readonly b: string;
	/** true = this pair **should** score high. */
	readonly shouldMatch: boolean;
}

export interface DiscriminationReport {
	readonly role: string;
	readonly rows: ReadonlyArray<{ label: string; score: number; shouldMatch: boolean }>;
	readonly minPositive: number;
	readonly maxNegative: number;
	/** Lowest positive score minus highest negative score. Only above 0 are the two groups separable. */
	readonly margin: number;
	readonly spread: number;
	readonly usable: boolean;
}

function summarize(
	role: string,
	rows: Array<{ label: string; score: number; shouldMatch: boolean }>,
	minMargin: number,
): DiscriminationReport {
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
 * Choose a threshold from one batch of probe scores.
 *
 * **This is the only workable route to "thresholds must be calibrated on your own data" when there
 * is no labelled data.** The industry-standard method samples 100–500 production log entries for
 * human labelling — which assumes a single corpus, a single deployment, and a corpus stable enough
 * to be worth paying someone to label once. Neither assumption holds when the corpus is uploaded by
 * end users and differs from batch to batch: there are no historical logs to label, and no
 * "label once, good for a long time" premise. Exactly one thing is available: **the corpus itself
 * is already in hand.** `generateProbes()` builds positives and negatives from it automatically,
 * and this function turns those scores into a number.
 *
 * **The unit of calibration is therefore one batch of probes, not one deployment.** Which corpus a
 * probe batch corresponds to, how often to re-run it, whether to build a separate cache instance
 * per batch — those are all the caller's business decisions. The library does not know that
 * granularity; it knows only these scores and the `corpus` label you supply (which is written into
 * `calibratedOn` verbatim).
 *
 * **The criterion follows `FINDINGS.md`**: among thresholds whose precision is ≥ `targetPrecision`,
 * take the one with the highest recall. Not the midpoint of the margin — that is only defined when
 * the two groups separate completely, whereas on a real corpus hard negatives like "L1
 * regularization / L2 regularization" overlap with the positives by nature.
 *
 *   precision = of those judged a hit, how many should have been (the inverse of a false hit, the
 *               expensive side)
 *   recall    = of those that should have hit, how many were found (a miss only wastes one
 *               generation, which is cheap)
 *
 * **When no threshold can be given, `threshold` is null and `calibratedOn` is the empty string.**
 * The latter is deliberate: an empty string passed to `Calibrated` throws at construction, so a
 * failed calibration cannot be carried into production by accident — getting nothing usable is
 * safer than getting a number that merely looks like one. The right response is to fall back to
 * gate ② exact matching (zero false-hit risk), or to run shadow mode until there is enough real
 * traffic.
 */
export interface ThresholdSuggestion {
	/** The suggested threshold. Null when none can be given; see `reason`. */
	readonly threshold: number | null;
	/** This θ's precision **on this probe batch**. Zero when no θ could be given. */
	readonly precision: number;
	/** This θ's recall **on this probe batch**. Zero when no θ could be given. */
	readonly recall: number;
	readonly positives: number;
	readonly negatives: number;
	/**
	 * The negative that holds θ up — the highest-scoring pair, and so the hardest pair in this
	 * corpus.
	 *
	 * It is reported because it is readable: `same unit, different concept · L1 regularization / L2
	 * regularization` shows at a glance where this course is hard, whereas "θ could only reach 0.93"
	 * does not. When the target precision cannot be met, this is the reason.
	 */
	readonly hardestNegative: { readonly label: string; readonly score: number } | null;
	/** Why no θ could be given; null when one was. */
	readonly reason: string | null;
	/** Goes straight into `Calibrated.calibratedOn`. Empty string when no θ could be given (which throws if used). */
	readonly calibratedOn: string;
}

export interface ThresholdSuggestionOptions {
	/**
	 * Where this probe batch came from, written into `calibratedOn` verbatim. How a corpus is
	 * identified is a business decision — tenant plus knowledge-base version, course plus term, the
	 * batch number of one import. The library does not interpret it.
	 *
	 * Required and non-empty, the same rule as `Calibrated.calibratedOn`: a threshold whose corpus
	 * nobody knows is one nobody dares touch six months later, and nobody can say whether it still
	 * holds.
	 */
	readonly corpus: string;
	/**
	 * Target precision, default 0.95 — the industry convention of not scaling up below 95%.
	 *
	 * Giving this a default does not violate "thresholds have no defaults": what is defaulted is the
	 * **trade-off** (how much more a false hit costs than a miss), not the threshold. θ is still
	 * determined entirely by this corpus's scores, and the trade-off value is written into
	 * `calibratedOn` where it stays visible.
	 */
	readonly targetPrecision?: number;
}

/** See `ThresholdSuggestion`. */
export function suggestThreshold(
	report: DiscriminationReport,
	options: ThresholdSuggestionOptions,
): ThresholdSuggestion {
	const corpus = options.corpus;
	if (typeof corpus !== "string" || corpus.trim() === "") {
		throw new Error(
			"suggestThreshold requires a corpus: which course, which term, which revision of the material this probe batch came from. " +
				"It is written into calibratedOn — a threshold whose corpus is unknown is no calibration at all.",
		);
	}
	const target = options.targetPrecision ?? 0.95;
	if (!Number.isFinite(target) || target <= 0 || target > 1) {
		throw new Error(`targetPrecision must fall in (0, 1], received ${String(options.targetPrecision)}.`);
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
	 * Both sides are required, and missing each has a different consequence: with no negatives,
	 * false hits cannot be measured and θ gets pushed as loose as it will go; with no positives,
	 * legitimate reuse being wrongly refused cannot be measured. The latter is exactly the "no
	 * phrasing hook, so not one positive could be built" case, which is the common one in a product.
	 */
	if (positives.length === 0) {
		return {
			...nothing,
			reason: 'Not a single positive: this probe batch can only bound false hits, not measure "how many that should have hit were missed", so any θ is guessing at recall. Give generateProbes a phrasing hook, or supply the teacher\'s own phrasings.',
		};
	}
	if (negatives.length === 0) {
		return {
			...nothing,
			reason: "Not a single negative: false hits cannot be measured, and false hits are exactly what this threshold exists to stop.",
		};
	}

	/**
	 * Candidate θ values are drawn only from **observed scores**. A value between two observations
	 * changes no verdict on this probe batch while making the reported precision look more precise
	 * than the evidence supports — the one exception being the fully-separable case below.
	 */
	let best: { threshold: number; precision: number; recall: number } | null = null;
	for (const theta of [...new Set(report.rows.map(r => r.score))].sort((a, b) => a - b)) {
		const tp = positives.filter(r => r.score >= theta).length;
		const fp = negatives.filter(r => r.score >= theta).length;
		if (tp === 0) {
			// A θ that keeps no positive at all is not a candidate, even at perfect precision.
			continue;
		}
		const precision = tp / (tp + fp);
		if (precision < target) {
			continue;
		}
		const recall = tp / positives.length;
		// Recall first; at equal recall take the higher θ — the same amount of reuse with fewer or
		// equally many false hits.
		if (best === null || recall > best.recall || (recall === best.recall && theta > best.threshold)) {
			best = { threshold: theta, precision, recall };
		}
	}

	if (best === null) {
		return {
			...nothing,
			reason:
				`Cannot reach ${(target * 100).toFixed(0)}% precision on this probe batch` +
				(hardest === null
					? "."
					: `: the hardest negative pair "${hardest.label}" scored ${hardest.score.toFixed(4)}, above too many positives.`) +
				" Either switch to a scorer that separates this course, or fall back to gate ② exact matching for it (zero false-hit risk)," +
				" or run shadow mode first and gather real traffic — do not ship a number borrowed from somewhere else.",
		};
	}

	/**
	 * When the groups separate completely, move θ to the midpoint of the gap.
	 *
	 * No verdict on this probe batch changes (no score lies in the gap), but each side gets half the
	 * gap as headroom: there are only a few dozen probes, and real traffic will eventually fill some
	 * of that gap — sitting flush against `minPositive`, the first legitimate paraphrase scoring
	 * slightly below it falls out.
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
			`${corpus} · ${report.rows.length} auto probes (${positives.length} positive / ${negatives.length} negative) · ` +
			`${report.role} scorer · θ=${threshold.toFixed(4)} (target precision ${(target * 100).toFixed(0)}%, ` +
			`measured precision ${(best.precision * 100).toFixed(1)}% / recall ${(best.recall * 100).toFixed(1)}%)`,
	};
}

/** For CI: throw when the groups do not separate, so a misapplied model never ships. */
export function assertDiscriminates(report: DiscriminationReport): void {
	if (report.usable) {
		return;
	}
	const detail = report.rows
		.map(r => `  ${r.shouldMatch ? "expect high" : "expect low "} ${r.score.toFixed(4)}  ${r.label}`)
		.join("\n");
	throw new Error(
		`Model role "${report.role}" lacks discriminating power: lowest positive ${report.minPositive.toFixed(4)}, ` +
			`highest negative ${report.maxNegative.toFixed(4)}, margin ${report.margin.toFixed(4)}.\n` +
			`This is most likely a misapplied model (a passage reranker used for question-to-question, say, or a sentence-pair model used for retrieval).\n${detail}`,
	);
}
