/**
 * The discrimination self-check.
 *
 * **The criterion has to be the margin, not the spread.** That is not a matter of taste: the
 * harness used the spread once, and that criterion passed a scorer whose ordering was entirely
 * inverted — the first test below is that counterexample.
 */

import {
	assertDiscriminates,
	checkPairEncoder,
	checkReranker,
	createMemoryCacheStore,
	createSemanticCache,
	generateProbes,
	type ProbePair,
	suggestThreshold,
} from "../src/index.ts";
import { forCosine } from "./Fakes.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const PROBES: ReadonlyArray<ProbePair> = [
	{ label: "同义", a: "什么是过拟合", b: "过拟合是什么意思", shouldMatch: true },
	{ label: "近义反义", a: "什么是过拟合", b: "什么是欠拟合", shouldMatch: false },
	{ label: "完全无关", a: "什么是过拟合", b: "成绩什么时候公布", shouldMatch: false },
];

test("an inverted scorer: a wide spread but a negative margin — must be judged unusable", async () => {
	// 0.1 where it should be high and 0.9 where it should be low: a spread of 0.8, which any
	// spread >= 0.15 criterion passes.
	const inverted = {
		score(_q: string, c: string): Promise<number> {
			return Promise.resolve(c === "过拟合是什么意思" ? 0.1 : 0.9);
		},
	};
	const report = await checkReranker(inverted, PROBES);
	assert.ok(report.spread > 0.15, `跨度 ${report.spread} 确实够大 —— 这正是旧判据会漏的原因`);
	assert.ok(report.margin < 0, `margin 应当为负，实际 ${report.margin}`);
	assert.equal(report.usable, false);
	assert.throws(() => assertDiscriminates(report), /lacks discriminating power/u);
});

test("a saturated scorer: every input scores almost the same — a margin near 0, unusable", async () => {
	const saturated = {
		score(): Promise<number> {
			return Promise.resolve(0.998);
		},
	};
	const report = await checkReranker(saturated, PROBES);
	assert.ok(Math.abs(report.margin) < 1e-9);
	assert.equal(report.usable, false);
	assert.throws(
		() => assertDiscriminates(report),
		(err: Error) => {
			// The message has to carry both groups' scores, or there is no telling saturation from
			// inversion.
			assert.match(err.message, /lowest positive 0\.9980/u);
			assert.match(err.message, /highest negative 0\.9980/u);
			assert.match(err.message, /expect high/u);
			return true;
		},
	);
});

test("a well-matched scorer: a positive margin above the minimum — usable", async () => {
	const good = {
		score(_q: string, c: string): Promise<number> {
			return Promise.resolve(c === "过拟合是什么意思" ? 0.92 : 0.3);
		},
	};
	const report = await checkReranker(good, PROBES);
	assert.equal(report.minPositive, 0.92);
	assert.equal(report.maxNegative, 0.3);
	assert.ok(report.usable);
	assert.doesNotThrow(() => assertDiscriminates(report));
});

test("checkPairEncoder compares question to question (symmetric) and embeds every probe in one batch", async () => {
	let calls = 0;
	const table: Record<string, ReadonlyArray<number>> = {
		什么是欠拟合: forCosine(0.4),
		成绩什么时候公布: forCosine(0.05),
	};
	const encoder = {
		embedQuestions(texts: ReadonlyArray<string>): Promise<Array<Array<number>>> {
			calls += 1;
			return Promise.resolve(texts.map(t => [...(table[t] ?? [1, 0, 0])]));
		},
	};
	const report = await checkPairEncoder(encoder, PROBES);
	assert.equal(calls, 1);
	assert.ok(report.usable, `margin ${report.margin}`);
	assert.equal(report.role, "pair");
});

test("with positives or negatives alone the margin is NaN, which must not count as 'usable'", async () => {
	const only = {
		score(): Promise<number> {
			return Promise.resolve(0.9);
		},
	};
	const positives = await checkReranker(only, [{ label: "只有正例", a: "a", b: "b", shouldMatch: true }]);
	assert.ok(Number.isNaN(positives.margin));
	assert.equal(positives.usable, false);
});

/* ---------- Choosing the floor from probe scores ---------- */

/**
 * This group guards the constraint that course sources are uploaded by a teacher and differ by
 * subject and by term: there are no historical logs to annotate, and no one can be paid to
 * annotate every course, so θ can only come from probe scores generated automatically at upload
 * time. The criterion follows FINDINGS: the θ with the highest hit rate subject to a true-hit rate
 * at or above the target.
 */

/** A fake scorer keyed on candidate text — the scores are fixed outright so the boundaries can be placed exactly. */
function scorer(byText: Readonly<Record<string, number>>) {
	return {
		score(_q: string, candidate: string): Promise<number> {
			return Promise.resolve(byText[candidate] ?? 0);
		},
	};
}

const CORPUS = { corpus: "ml101 · 2026 秋 · 资料 v3" };

test("when fully separable θ takes the gap's midpoint — flush against the lowest positive, the first slightly lower legitimate paraphrase falls out", async () => {
	const report = await checkReranker(scorer({ 同义: 0.9, 难负例: 0.5, 易负例: 0.1 }), [
		{ label: "同义", a: "q", b: "同义", shouldMatch: true },
		{ label: "难负例", a: "q", b: "难负例", shouldMatch: false },
		{ label: "易负例", a: "q", b: "易负例", shouldMatch: false },
	]);
	const s = suggestThreshold(report, CORPUS);
	assert.ok(Math.abs((s.threshold ?? 0) - 0.7) < 1e-9, `θ 应当是 (0.5+0.9)/2，实际 ${s.threshold}`);
	assert.equal(s.precision, 1);
	assert.equal(s.recall, 1);
	assert.equal(s.reason, null);
	assert.equal(s.hardestNegative?.label, "难负例");
	assert.match(s.calibratedOn, /ml101 · 2026 秋 · 资料 v3/u);
	assert.match(s.calibratedOn, /1 positive \/ 2 negative/u);
});

test("when they overlap: take the θ with the highest hit rate subject to a true-hit rate of ≥95%", async () => {
	// Positives at 0.95/0.90/0.60 and negatives at 0.80/0.50: the 0.6 positive and the 0.8 negative
	// are inverted, which is common on real corpora ("L1 regularization" and "L2 regularization"
	// look more alike than some paraphrases do).
	const report = await checkReranker(scorer({ 正1: 0.95, 正2: 0.9, 正3: 0.6, 负1: 0.8, 负2: 0.5 }), [
		{ label: "正1", a: "q", b: "正1", shouldMatch: true },
		{ label: "正2", a: "q", b: "正2", shouldMatch: true },
		{ label: "正3", a: "q", b: "正3", shouldMatch: true },
		{ label: "负1", a: "q", b: "负1", shouldMatch: false },
		{ label: "负2", a: "q", b: "负2", shouldMatch: false },
	]);
	const s = suggestThreshold(report, CORPUS);
	assert.equal(s.threshold, 0.9, "0.9 是唯一能把两条负例都挡在外面、又留住两条正例的取值");
	assert.equal(s.precision, 1);
	assert.ok(Math.abs(s.recall - 2 / 3) < 1e-9, `命中率应当是 2/3，实际 ${s.recall}`);
	// When they are not separable the midpoint is off limits: there are scores inside the gap, and
	// moving there changes verdicts.
	assert.ok(report.margin < 0);
});

test("failing to reach the target true-hit rate produces no θ — and a failed calibration cannot ship", async () => {
	const report = await checkReranker(scorer({ 正1: 0.9, 正2: 0.85, "同章不同概念 · L1 正则化 ／ L2 正则化": 0.95 }), [
		{ label: "正1", a: "q", b: "正1", shouldMatch: true },
		{ label: "正2", a: "q", b: "正2", shouldMatch: true },
		{
			label: "同章不同概念 · L1 正则化 ／ L2 正则化",
			a: "q",
			b: "同章不同概念 · L1 正则化 ／ L2 正则化",
			shouldMatch: false,
		},
	]);
	const s = suggestThreshold(report, CORPUS);
	assert.equal(s.threshold, null);
	assert.match(String(s.reason), /L1 正则化 ／ L2 正则化/u, "要点名是哪一对顶住了 θ");
	assert.match(
		String(s.reason),
		/gate ② exact matching/u,
		"it has to name a fallback route, not merely report failure",
	);

	/**
	 * `calibratedOn` is the empty string, so dropping this straight into `Calibrated` throws at
	 * construction. A failed calibration handing back nothing usable is safer than handing back a
	 * number that merely looks like one.
	 */
	assert.equal(s.calibratedOn, "");
	assert.throws(
		() =>
			createSemanticCache({
				recall: {
					scorer: {
						embedQuestions(t: ReadonlyArray<string>) {
							return Promise.resolve(t.map(() => [1, 0, 0]));
						},
					},
					thresholds: { floor: s.threshold ?? 0.8 },
					calibratedOn: s.calibratedOn,
				},
				store: createMemoryCacheStore(),
				retriever: {
					retrieve() {
						return Promise.resolve([]);
					},
				},
				scope: () => ({ key: "course:1", shared: true, org: "acme" }),
			}),
		/calibratedOn must not be an empty string/u,
	);
});

test("no positives at all: no θ is produced, and the report points at wiring up phrasing — the most common failure in production", async () => {
	const report = await checkReranker(scorer({ 负1: 0.8, 负2: 0.5 }), [
		{ label: "负1", a: "q", b: "负1", shouldMatch: false },
		{ label: "负2", a: "q", b: "负2", shouldMatch: false },
	]);
	const s = suggestThreshold(report, CORPUS);
	assert.equal(s.threshold, null);
	assert.match(String(s.reason), /Not a single positive/u);
	assert.match(String(s.reason), /phrasing/u);
	assert.equal(s.calibratedOn, "");
});

test("no negatives at all: false hits cannot be measured, so again no θ", async () => {
	const report = await checkReranker(scorer({ 正1: 0.9 }), [{ label: "正1", a: "q", b: "正1", shouldMatch: true }]);
	const s = suggestThreshold(report, CORPUS);
	assert.equal(s.threshold, null);
	assert.match(String(s.reason), /Not a single negative/u);
});

test("corpus is required and targetPrecision must fall in (0,1] — the same rule as calibratedOn", async () => {
	const report = await checkReranker(scorer({ 正1: 0.9, 负1: 0.2 }), [
		{ label: "正1", a: "q", b: "正1", shouldMatch: true },
		{ label: "负1", a: "q", b: "负1", shouldMatch: false },
	]);
	assert.throws(() => suggestThreshold(report, { corpus: "  " }), /suggestThreshold requires a corpus/u);
	assert.throws(() => suggestThreshold(report, { ...CORPUS, targetPrecision: 0 }), /targetPrecision/u);
	assert.throws(() => suggestThreshold(report, { ...CORPUS, targetPrecision: 1.2 }), /targetPrecision/u);
	assert.doesNotThrow(() => suggestThreshold(report, { ...CORPUS, targetPrecision: 1 }));
});

test("the full loop: uploaded sources to automatic probes to scores to θ to a usable RecallStage", async () => {
	/**
	 * This is the point of the whole thing: with no human annotation and no historical logs, just
	 * five sources a teacher uploaded a moment ago, one pass round produces this course's own
	 * threshold.
	 */
	const sources = ["L1 正则化", "L2 正则化", "过拟合", "批归一化", "残差连接"].map((title, i) => ({
		id: `d${i}`,
		unit: i < 3 ? "ch3" : "ch5",
		title,
		questions: [`什么是${title}？`, `${title}怎么理解？`],
	}));
	// Two phrasings of one source share a vector, and different sources are spread by index —
	// 1.0 within a source, 0.939 to its neighbour.
	const angle = new Map<string, number>();
	for (const [i, s] of sources.entries()) {
		for (const q of s.questions) {
			angle.set(q, i * 0.35);
		}
	}
	const encoder = {
		embedQuestions(texts: ReadonlyArray<string>): Promise<Array<Array<number>>> {
			return Promise.resolve(
				texts.map(t => {
					const a = angle.get(t) ?? 3;
					return [Math.cos(a), Math.sin(a), 0];
				}),
			);
		},
	};

	const probes = await generateProbes(sources);
	const report = await checkPairEncoder(encoder, probes.probes);
	const suggestion = suggestThreshold(report, { corpus: "ml101 · 2026 秋" });

	assert.notEqual(suggestion.threshold, null, `应当标得出来，实际 ${suggestion.reason}`);
	assert.equal(suggestion.recall, 1, "同篇资料的两种问法必须全部留住");
	assert.equal(suggestion.precision, 1);
	assert.notEqual(suggestion.calibratedOn, "");

	// Feed it straight into this course's cache: the threshold arrives bound to where it was
	// calibrated.
	assert.doesNotThrow(() =>
		createSemanticCache({
			recall: {
				scorer: encoder,
				thresholds: { floor: suggestion.threshold ?? 0 },
				calibratedOn: suggestion.calibratedOn,
			},
			store: createMemoryCacheStore(),
			retriever: {
				retrieve() {
					return Promise.resolve([]);
				},
			},
			scope: () => ({ key: "course:ml101", shared: true, org: "acme" }),
		}),
	);
});
