/**
 * 判别力自检。
 *
 * **判据必须是 margin，不能是跨度。** 这不是口味问题：验证台先前用跨度，那条判据
 * 让「顺序整个反过来」的打分器也能过关 —— 下面第一个测试就是那个反例。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	assertDiscriminates,
	checkPairEncoder,
	checkReranker,
	createMemoryCacheStore,
	createSemanticCache,
	generateProbes,
	suggestThreshold,
	type ProbePair,
} from "../src/index.ts";
import { forCosine } from "./Fakes.ts";

const PROBES: ReadonlyArray<ProbePair> = [
	{ label: "同义", a: "什么是过拟合", b: "过拟合是什么意思", shouldMatch: true },
	{ label: "近义反义", a: "什么是过拟合", b: "什么是欠拟合", shouldMatch: false },
	{ label: "完全无关", a: "什么是过拟合", b: "成绩什么时候公布", shouldMatch: false },
];

test("顺序反过来的打分器：跨度很大但 margin 为负 —— 必须判为不可用", async () => {
	// 该高的给 0.1，该低的给 0.9：跨度 0.8，任何「跨度 ≥ 0.15」的判据都会放它过关
	const inverted = { async score(_q: string, c: string): Promise<number> { return c === "过拟合是什么意思" ? 0.1 : 0.9; } };
	const report = await checkReranker(inverted, PROBES);
	assert.ok(report.spread > 0.15, `跨度 ${report.spread} 确实够大 —— 这正是旧判据会漏的原因`);
	assert.ok(report.margin < 0, `margin 应当为负，实际 ${report.margin}`);
	assert.equal(report.usable, false);
	assert.throws(() => assertDiscriminates(report), /判别力不足/u);
});

test("饱和的打分器：所有输入几乎同分 —— margin 接近 0，不可用", async () => {
	const saturated = { async score(): Promise<number> { return 0.998; } };
	const report = await checkReranker(saturated, PROBES);
	assert.ok(Math.abs(report.margin) < 1e-9);
	assert.equal(report.usable, false);
	assert.throws(() => assertDiscriminates(report), (err: Error) => {
		// 报错信息里要带上两组的分数，否则看不出是饱和还是顺序反
		assert.match(err.message, /正例最低 0\.9980/u);
		assert.match(err.message, /负例最高 0\.9980/u);
		assert.match(err.message, /应高/u);
		return true;
	});
});

test("任务匹配的打分器：margin 为正且过门槛 —— 可用", async () => {
	const good = { async score(_q: string, c: string): Promise<number> { return c === "过拟合是什么意思" ? 0.92 : 0.3; } };
	const report = await checkReranker(good, PROBES);
	assert.equal(report.minPositive, 0.92);
	assert.equal(report.maxNegative, 0.3);
	assert.ok(report.usable);
	assert.doesNotThrow(() => assertDiscriminates(report));
});

test("checkPairEncoder 比的是问题↔问题（对称），一次批量编码全部探针", async () => {
	let calls = 0;
	const table: Record<string, ReadonlyArray<number>> = {
		什么是欠拟合: forCosine(0.4),
		成绩什么时候公布: forCosine(0.05),
	};
	const encoder = {
		async embedQuestions(texts: ReadonlyArray<string>): Promise<Array<Array<number>>> {
			calls += 1;
			return texts.map(t => [...(table[t] ?? [1, 0, 0])]);
		},
	};
	const report = await checkPairEncoder(encoder, PROBES);
	assert.equal(calls, 1);
	assert.ok(report.usable, `margin ${report.margin}`);
	assert.equal(report.role, "pair");
});

test("只有正例或只有负例时 margin 是 NaN，不能算「可用」", async () => {
	const only = { async score(): Promise<number> { return 0.9; } };
	const positives = await checkReranker(only, [{ label: "只有正例", a: "a", b: "b", shouldMatch: true }]);
	assert.ok(Number.isNaN(positives.margin));
	assert.equal(positives.usable, false);
});

/* ---------- 从探针分数选闸值 ---------- */

/**
 * 这一组守的是「课程资料是老师上传的，每科每学期都不一样」那个约束：
 * 没有可标的历史日志，也不可能为每门课请人标一遍，所以 θ 只能从上传时自动造出的
 * 探针分数里来。判据照搬 FINDINGS 的口径：正命中率 ≥ 目标值的前提下取命中率最高的 θ。
 */

/** 按候选文本给分的假打分器 —— 分数直接写死，边界才摆得准 */
function scorer(byText: Readonly<Record<string, number>>) {
	return { async score(_q: string, candidate: string): Promise<number> { return byText[candidate] ?? 0; } };
}

const CORPUS = { corpus: "ml101 · 2026 秋 · 资料 v3" };

test("完全分得开时 θ 取空隙中点 —— 贴着正例最低分放，第一条略低的合法改写就掉出去了", async () => {
	const report = await checkReranker(
		scorer({ 同义: 0.9, 难负例: 0.5, 易负例: 0.1 }),
		[
			{ label: "同义", a: "q", b: "同义", shouldMatch: true },
			{ label: "难负例", a: "q", b: "难负例", shouldMatch: false },
			{ label: "易负例", a: "q", b: "易负例", shouldMatch: false },
		],
	);
	const s = suggestThreshold(report, CORPUS);
	assert.ok(Math.abs((s.threshold ?? 0) - 0.7) < 1e-9, `θ 应当是 (0.5+0.9)/2，实际 ${s.threshold}`);
	assert.equal(s.precision, 1);
	assert.equal(s.recall, 1);
	assert.equal(s.reason, null);
	assert.equal(s.hardestNegative?.label, "难负例");
	assert.match(s.calibratedOn, /ml101 · 2026 秋 · 资料 v3/u);
	assert.match(s.calibratedOn, /正 1 \/ 负 2/u);
});

test("有重叠时：在正命中率 ≥95% 的前提下取命中率最高的那个 θ", async () => {
	// 正例 0.95/0.90/0.60，负例 0.80/0.50 —— 0.6 那条正例和 0.8 那条负例是反的，
	// 真实语料上这很常见（「L1 正则化」和「L2 正则化」比某些同义改写还像）
	const report = await checkReranker(
		scorer({ 正1: 0.95, 正2: 0.9, 正3: 0.6, 负1: 0.8, 负2: 0.5 }),
		[
			{ label: "正1", a: "q", b: "正1", shouldMatch: true },
			{ label: "正2", a: "q", b: "正2", shouldMatch: true },
			{ label: "正3", a: "q", b: "正3", shouldMatch: true },
			{ label: "负1", a: "q", b: "负1", shouldMatch: false },
			{ label: "负2", a: "q", b: "负2", shouldMatch: false },
		],
	);
	const s = suggestThreshold(report, CORPUS);
	assert.equal(s.threshold, 0.9, "0.9 是唯一能把两条负例都挡在外面、又留住两条正例的取值");
	assert.equal(s.precision, 1);
	assert.ok(Math.abs(s.recall - 2 / 3) < 1e-9, `命中率应当是 2/3，实际 ${s.recall}`);
	// 不可分时不许挪到中点：空隙里有分数，挪过去就是在改判定
	assert.ok(report.margin < 0);
});

test("达不到目标正命中率时给不出 θ —— 而且失败的标定带不上线", async () => {
	const report = await checkReranker(
		scorer({ 正1: 0.9, 正2: 0.85, "同章不同概念 · L1 正则化 ／ L2 正则化": 0.95 }),
		[
			{ label: "正1", a: "q", b: "正1", shouldMatch: true },
			{ label: "正2", a: "q", b: "正2", shouldMatch: true },
			{
				label: "同章不同概念 · L1 正则化 ／ L2 正则化",
				a: "q",
				b: "同章不同概念 · L1 正则化 ／ L2 正则化",
				shouldMatch: false,
			},
		],
	);
	const s = suggestThreshold(report, CORPUS);
	assert.equal(s.threshold, null);
	assert.match(String(s.reason), /L1 正则化 ／ L2 正则化/u, "要点名是哪一对顶住了 θ");
	assert.match(String(s.reason), /退回 ② 精确匹配/u, "要给出降级路径，而不是只说失败");

	/**
	 * `calibratedOn` 是空串 —— 顺手填进 `Calibrated` 会在构造期抛。
	 * 一次失败的标定拿不到能用的东西，比拿到一个看着像数的数安全。
	 */
	assert.equal(s.calibratedOn, "");
	assert.throws(
		() =>
			createSemanticCache({
				recall: { scorer: { async embedQuestions(t: ReadonlyArray<string>) { return t.map(() => [1, 0, 0]); } }, thresholds: { floor: s.threshold ?? 0.8 }, calibratedOn: s.calibratedOn },
				store: createMemoryCacheStore(),
				retriever: { async retrieve() { return []; } },
				scope: () => ({ key: "course:1", shared: true, org: "acme" }),
				sourceVersion: () => "v1",
			}),
		/calibratedOn 不能是空串/u,
	);
});

test("一条正例都没有：给不出 θ，并指出该去接 phrasing —— 产品里最常见的那种失败", async () => {
	const report = await checkReranker(scorer({ 负1: 0.8, 负2: 0.5 }), [
		{ label: "负1", a: "q", b: "负1", shouldMatch: false },
		{ label: "负2", a: "q", b: "负2", shouldMatch: false },
	]);
	const s = suggestThreshold(report, CORPUS);
	assert.equal(s.threshold, null);
	assert.match(String(s.reason), /一条正例都没有/u);
	assert.match(String(s.reason), /phrasing/u);
	assert.equal(s.calibratedOn, "");
});

test("一条负例都没有：量不出假命中，同样不给 θ", async () => {
	const report = await checkReranker(scorer({ 正1: 0.9 }), [{ label: "正1", a: "q", b: "正1", shouldMatch: true }]);
	const s = suggestThreshold(report, CORPUS);
	assert.equal(s.threshold, null);
	assert.match(String(s.reason), /一条负例都没有/u);
});

test("corpus 必填、targetPrecision 要落在 (0,1] —— 和 calibratedOn 同一条规矩", async () => {
	const report = await checkReranker(scorer({ 正1: 0.9, 负1: 0.2 }), [
		{ label: "正1", a: "q", b: "正1", shouldMatch: true },
		{ label: "负1", a: "q", b: "负1", shouldMatch: false },
	]);
	assert.throws(() => suggestThreshold(report, { corpus: "  " }), /suggestThreshold 需要 corpus/u);
	assert.throws(() => suggestThreshold(report, { ...CORPUS, targetPrecision: 0 }), /targetPrecision/u);
	assert.throws(() => suggestThreshold(report, { ...CORPUS, targetPrecision: 1.2 }), /targetPrecision/u);
	assert.doesNotThrow(() => suggestThreshold(report, { ...CORPUS, targetPrecision: 1 }));
});

test("闭环：上传的资料 → 自动探针 → 分数 → θ → 一个能用的 RecallStage", async () => {
	/**
	 * 这条是整件事的意义所在：没有任何人工标注，也没有历史日志，
	 * 只有老师刚传上来的五篇资料，走完一圈就得到了这门课自己的阈值。
	 */
	const sources = ["L1 正则化", "L2 正则化", "过拟合", "批归一化", "残差连接"].map((title, i) => ({
		id: `d${i}`,
		unit: i < 3 ? "ch3" : "ch5",
		title,
		questions: [`什么是${title}？`, `${title}怎么理解？`],
	}));
	// 同一篇资料的两种问法向量相同，不同资料按序号拉开角度 —— 同篇 1.0，隔壁 0.939
	const angle = new Map<string, number>();
	for (const [i, s] of sources.entries()) for (const q of s.questions) angle.set(q, i * 0.35);
	const encoder = {
		async embedQuestions(texts: ReadonlyArray<string>): Promise<Array<Array<number>>> {
			return texts.map(t => {
				const a = angle.get(t) ?? 3;
				return [Math.cos(a), Math.sin(a), 0];
			});
		},
	};

	const probes = await generateProbes(sources);
	const report = await checkPairEncoder(encoder, probes.probes);
	const suggestion = suggestThreshold(report, { corpus: "ml101 · 2026 秋" });

	assert.notEqual(suggestion.threshold, null, `应当标得出来，实际 ${suggestion.reason}`);
	assert.equal(suggestion.recall, 1, "同篇资料的两种问法必须全部留住");
	assert.equal(suggestion.precision, 1);
	assert.notEqual(suggestion.calibratedOn, "");

	// 直接拿去构造这门课的缓存 —— 阈值与它的标定出处捆在一起进来
	assert.doesNotThrow(() =>
		createSemanticCache({
			recall: { scorer: encoder, thresholds: { floor: suggestion.threshold ?? 0 }, calibratedOn: suggestion.calibratedOn },
			store: createMemoryCacheStore(),
			retriever: { async retrieve() { return []; } },
			scope: () => ({ key: "course:ml101", shared: true, org: "acme" }),
			sourceVersion: () => "v1",
		}),
	);
});
