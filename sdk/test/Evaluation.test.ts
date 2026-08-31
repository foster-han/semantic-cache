/**
 * 离线评测的判据。
 *
 * 这里只有一件事要守住：**判据是「答案的首要依据是不是那篇资料」，不是「有没有复用」。**
 * 判据放松成「期望文档出现在 top-k 里」会把「复用了过拟合的答案给问欠拟合的学生」
 * 判成通过；紧成「必须复用」则会把「命中另一条内容正确的缓存」判成失败。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compare, evaluate, sourceIdsOf, type Scenario } from "../src/index.ts";
import type { CachedPayload, CachePrompt } from "../src/types/Pipeline.ts";
import { forCosine, harness } from "./Fakes.ts";

/** 生成时按 retrievalText 决定依据哪篇资料 —— 场景要的就是这个可控性 */
const SOURCES: Readonly<Record<string, string>> = {
	"什么是过拟合？": "n5",
	"过拟合是什么意思？": "n5",
	"什么是欠拟合？": "n6",
	"完全无关的问题": "n9",
};
const generate = async (prompt: CachePrompt): Promise<CachedPayload> => ({
	kind: "answer",
	answer: `关于「${prompt.retrievalText}」的答案`,
	sourceIds: [SOURCES[prompt.retrievalText] ?? "n0"],
});

function prompt(text: string): CachePrompt {
	return { matchText: text, retrievalText: text, context: {} };
}

test("判据落在 sourceIds[0] 上：复用另一条内容正确的缓存算通过，复用错的算假命中", async () => {
	const { cache, store } = harness();
	const scenarios: Array<Scenario> = [
		{
			key: "paraphrase",
			label: "同义改写",
			seed: prompt("什么是过拟合？"),
			probe: prompt("过拟合是什么意思？"),
			expectSourceId: "n5",
		},
		{
			key: "antonym",
			label: "近义反义",
			seed: prompt("什么是欠拟合？"),
			probe: prompt("什么是过拟合？"),
			expectSourceId: "n5",
		},
	];
	const report = await evaluate(cache, scenarios, generate, { reset: () => store.clear() });

	const byKey = new Map(report.rows.map(r => [r.key, r]));
	const paraphrase = byKey.get("paraphrase");
	assert.equal(paraphrase?.outcome, "reuse", "同义改写该命中种子那条");
	assert.equal(paraphrase?.primarySource, "n5");
	assert.equal(paraphrase?.ok, true);
	assert.equal(paraphrase?.falseHit, false);

	const antonym = byKey.get("antonym");
	assert.equal(antonym?.primarySource, "n6", "复用了欠拟合那条");
	assert.equal(antonym?.ok, false);
	assert.equal(antonym?.falseHit, true, "复用了缓存但首要依据不对 —— 学生拿到错答案");

	assert.equal(report.total, 2);
	assert.equal(report.passed, 1);
	assert.equal(report.falseHits, 1);
});

test("重新生成但依据不对：算不通过，但**不算**假命中", async () => {
	const { cache, store } = harness({ pair: { 完全无关的问题: forCosine(0.05) }, recallFloor: 0.5 });
	const report = await evaluate(
		cache,
		[
			{
				key: "cold",
				label: "对照组",
				seed: prompt("什么是过拟合？"),
				probe: prompt("完全无关的问题"),
				expectSourceId: "n5",
			},
		],
		generate,
		{ reset: () => store.clear() },
	);
	assert.equal(report.rows[0].outcome, "generated");
	assert.equal(report.rows[0].ok, false);
	assert.equal(report.rows[0].falseHit, false, "没复用就不是假命中，只是这条用例没落在期望资料上");
});

test("reset 与 warm 每条场景都跑 —— 不灌干扰缓存召回永远只有一条候选", async () => {
	const { cache, store } = harness();
	let resets = 0;
	let warms = 0;
	await evaluate(
		cache,
		["a", "b"].map(k => ({
			key: k,
			label: k,
			seed: prompt("什么是过拟合？"),
			probe: prompt("过拟合是什么意思？"),
			expectSourceId: "n5",
		})),
		generate,
		{
			reset: async () => {
				resets += 1;
				await store.clear();
			},
			warm: async (c, g) => {
				warms += 1;
				await c.resolve(prompt("什么是欠拟合？"), g);
			},
		},
	);
	assert.equal(resets, 2);
	assert.equal(warms, 2);
});

test("between 在播种与探测之间跑 —— 语料改版那两条靠它", async () => {
	let version = "v1";
	const { cache, store } = harness({ sourceVersion: () => version });
	const report = await evaluate(
		cache,
		[
			{
				key: "bump",
				label: "语料改版",
				seed: prompt("什么是过拟合？"),
				probe: prompt("什么是过拟合？"),
				expectSourceId: "n5",
				between: async () => {
					version = "v2";
				},
			},
		],
		generate,
		{
			reset: async () => {
				version = "v1";
				await store.clear();
			},
		},
	);
	assert.equal(report.rows[0].outcome, "generated", "版本变了就该被 ⑤ 拦下并重生成");
	assert.equal(report.rows[0].exitedAt, 5);
	assert.equal(report.rows[0].ok, true, "重生成之后依据是对的 —— 这条用例通过");
});

test("compare：差值是那道闸的价值，回归的用例逐条列出", () => {
	const a = {
		rows: [
			{ key: "x", label: "用例 X", expectSourceId: "n5", actualSourceIds: ["n5"], primarySource: "n5", outcome: "reuse", exitedAt: null, ok: true, falseHit: false },
			{ key: "y", label: "用例 Y", expectSourceId: "n6", actualSourceIds: ["n6"], primarySource: "n6", outcome: "generated", exitedAt: 6, ok: true, falseHit: false },
		],
		total: 2,
		passed: 2,
		falseHits: 0,
	};
	const b = {
		rows: [
			{ key: "x", label: "用例 X", expectSourceId: "n5", actualSourceIds: ["n9"], primarySource: "n9", outcome: "reuse", exitedAt: null, ok: false, falseHit: true },
			{ key: "y", label: "用例 Y", expectSourceId: "n6", actualSourceIds: ["n6"], primarySource: "n6", outcome: "reuse", exitedAt: null, ok: true, falseHit: false },
		],
		total: 2,
		passed: 1,
		falseHits: 1,
	};
	const diff = compare(a, b);
	assert.equal(diff.falseHitDelta, 1);
	assert.deepEqual(diff.regressed, ["用例 X"]);
	// 差值为 0 时如实返回 0 —— 一道闸在你的数据上没用，这个事实本身有价值
	assert.equal(compare(a, a).falseHitDelta, 0);
	assert.deepEqual(compare(a, a).regressed, []);
});

test("sourceIdsOf 保留顺序 —— 顺序即重要性，[0] 是判据", () => {
	assert.deepEqual(sourceIdsOf([{ id: "n5", text: "" }, { id: "n7", text: "" }]), ["n5", "n7"]);
});
