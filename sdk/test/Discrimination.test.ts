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
	checkRetrievalEncoder,
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

test("checkRetrievalEncoder 分开走 query 侧与 passage 侧", async () => {
	const seen: Array<string> = [];
	const encoder = {
		async embedQuery(texts: ReadonlyArray<string>): Promise<Array<Array<number>>> {
			seen.push("query");
			return texts.map(() => [1, 0, 0]);
		},
		async embedPassage(texts: ReadonlyArray<string>): Promise<Array<Array<number>>> {
			seen.push("passage");
			return texts.map(t => (t === "过拟合是什么意思" ? [1, 0, 0] : [...forCosine(0.2)]));
		},
	};
	const report = await checkRetrievalEncoder(encoder, PROBES);
	assert.deepEqual(seen, ["query", "passage"], "两侧必须各走一次，混用会让分数失去意义");
	assert.equal(report.role, "retrieval");
	assert.ok(report.usable);
});

test("只有正例或只有负例时 margin 是 NaN，不能算「可用」", async () => {
	const only = { async score(): Promise<number> { return 0.9; } };
	const positives = await checkReranker(only, [{ label: "只有正例", a: "a", b: "b", shouldMatch: true }]);
	assert.ok(Number.isNaN(positives.margin));
	assert.equal(positives.usable, false);
});
