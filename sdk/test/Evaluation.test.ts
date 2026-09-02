/**
 * The criterion offline evaluation judges by.
 *
 * **The criterion is which space the answer came from, not whether anything was reused.** Tightened
 * to "reuse is required", it fails a hit on another entry whose content is right; and it must rest
 * on the space the entry actually lives in rather than on the outcome word.
 *
 * The criterion used to be finer — entries recorded the documents they cited, and a scenario named
 * the one document the probe's answer had to rest on. That dimension has been removed, and this
 * suite is a demonstration of the cost: because scope isolation is enforced at ① and re-checked at
 * ③, an entry from another space can never be recalled, so `falseHit` no longer detects a
 * retrieval-precision failure. **What it detects now is a scope-routing failure** — the probe was
 * answered out of a space the scenario did not expect. On a corpus where everything lives in one
 * space it cannot fire at all, and a false-hit count of zero then means "there was no second space
 * to be wrong about", not "nothing went wrong".
 */

import { compare, evaluate, type Scenario } from "../src/index.ts";
import type { CachedPayload, CachePrompt } from "../src/types/Pipeline.ts";
import { forCosine, harness } from "./Fakes.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const generate = async (prompt: CachePrompt): Promise<CachedPayload> => ({
	kind: "answer",
	answer: `关于「${prompt.retrievalText}」的答案`,
});

function prompt(text: string, context: Record<string, string> = {}): CachePrompt {
	return { matchText: text, retrievalText: text, context };
}

/** The default harness scope, composed the way `composeScope` composes it. */
const SPACE = "org:1|course:1";

test("reuse from the expected space passes, and a hit on another entry whose content is right is still a pass", async () => {
	const { cache, store } = harness();
	const scenarios: Array<Scenario> = [
		{
			key: "paraphrase",
			label: "同义改写",
			seed: prompt("什么是过拟合？"),
			probe: prompt("过拟合是什么意思？"),
			expectSpace: SPACE,
		},
		{
			// Under the old per-document criterion this was a false hit: the probe reuses the
			// underfitting entry. The space is the same, so it now passes — precisely the resolution
			// that got coarser.
			key: "antonym",
			label: "近义反义",
			seed: prompt("什么是欠拟合？"),
			probe: prompt("什么是过拟合？"),
			expectSpace: SPACE,
		},
	];
	const report = await evaluate(cache, scenarios, generate, { reset: () => store.clear() });

	const byKey = new Map(report.rows.map(r => [r.key, r]));
	assert.equal(byKey.get("paraphrase")?.outcome, "reuse", "同义改写该命中种子那条");
	assert.equal(byKey.get("paraphrase")?.actualSpace, SPACE);
	assert.equal(byKey.get("paraphrase")?.ok, true);
	assert.equal(byKey.get("antonym")?.outcome, "reuse");
	assert.equal(byKey.get("antonym")?.ok, true);

	assert.equal(report.total, 2);
	assert.equal(report.passed, 2);
	assert.equal(report.falseHits, 0);
});

/**
 * The one shape that still produces a false hit: the probe **was** answered out of the cache, and
 * out of a space the scenario did not expect. A scope resolver that merges two courses — or one
 * that reads the tenant from outside the request — looks exactly like this.
 */
test("reused out of an unexpected space is a false hit", async () => {
	const { cache, store } = harness();
	const report = await evaluate(
		cache,
		[
			{
				key: "wrong-space",
				label: "落在别的 space",
				seed: prompt("什么是过拟合？"),
				probe: prompt("过拟合是什么意思？"),
				expectSpace: "org:1|course:2",
			},
		],
		generate,
		{ reset: () => store.clear() },
	);
	assert.equal(report.rows[0].outcome, "reuse");
	assert.equal(report.rows[0].actualSpace, SPACE);
	assert.equal(report.rows[0].ok, false);
	assert.equal(report.rows[0].falseHit, true, "复用了缓存，但答案来自另一个 space");
	assert.equal(report.falseHits, 1);
});

test("regenerated in the wrong space: a failure, but not a false hit", async () => {
	const { cache, store } = harness({ pair: { 完全无关的问题: forCosine(0.05) }, recallFloor: 0.5 });
	const report = await evaluate(
		cache,
		[
			{
				key: "cold",
				label: "对照组",
				seed: prompt("什么是过拟合？"),
				probe: prompt("完全无关的问题"),
				expectSpace: "org:1|course:2",
			},
		],
		generate,
		{ reset: () => store.clear() },
	);
	assert.equal(report.rows[0].outcome, "generated");
	assert.equal(report.rows[0].ok, false);
	assert.equal(report.rows[0].falseHit, false, "没复用就不是假命中，只是这条用例没落在期望的 space 上");
});

test("reset and warm run for every scenario — without distractors recall would only ever have one candidate", async () => {
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
			expectSpace: SPACE,
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

/**
 * `between` used to carry the two source-revision cases: bump the version fingerprint between
 * seeding and probing and watch ⑤ evict. With ⑤ gone the revision case is spelled as clearing the
 * space, which is also what the hook's ordering guarantee is now for.
 */
test("between runs after seeding and before probing", async () => {
	const { cache, store } = harness();
	const report = await evaluate(
		cache,
		[
			{
				key: "bump",
				label: "语料改版",
				seed: prompt("什么是过拟合？"),
				probe: prompt("什么是过拟合？"),
				expectSpace: SPACE,
				between: async () => {
					// Ordered after the seed: if this ran first there would be nothing to clear and the
					// probe would hit the seed instead of regenerating.
					assert.equal((await store.all()).length, 1, "between 必须在播种之后跑");
					await cache.clear({ org: "org:1", key: "course:1" });
				},
			},
		],
		generate,
		{ reset: () => store.clear() },
	);
	assert.equal(report.rows[0].outcome, "generated", "清掉 space 之后该重新生成");
	assert.equal(report.rows[0].ok, true, "重生成落在期望的 space 里 —— 这条用例通过");
});

test("compare: the delta is that gate's value, and every regressed case is listed individually", () => {
	const a = {
		rows: [
			{
				key: "x",
				label: "用例 X",
				expectSpace: SPACE,
				actualSpace: SPACE,
				outcome: "reuse",
				exitedAt: null,
				ok: true,
				falseHit: false,
			},
			{
				key: "y",
				label: "用例 Y",
				expectSpace: "org:1|course:2",
				actualSpace: "org:1|course:2",
				outcome: "generated",
				exitedAt: 3,
				ok: true,
				falseHit: false,
			},
		],
		total: 2,
		passed: 2,
		falseHits: 0,
	};
	const b = {
		rows: [
			{
				key: "x",
				label: "用例 X",
				expectSpace: SPACE,
				actualSpace: "org:9|course:1",
				outcome: "reuse",
				exitedAt: null,
				ok: false,
				falseHit: true,
			},
			{
				key: "y",
				label: "用例 Y",
				expectSpace: "org:1|course:2",
				actualSpace: "org:1|course:2",
				outcome: "reuse",
				exitedAt: null,
				ok: true,
				falseHit: false,
			},
		],
		total: 2,
		passed: 1,
		falseHits: 1,
	};
	const diff = compare(a, b);
	assert.equal(diff.falseHitDelta, 1);
	assert.deepEqual(diff.regressed, ["用例 X"]);
	// A delta of 0 is reported as 0: that a gate buys nothing on your data is itself worth knowing.
	assert.equal(compare(a, a).falseHitDelta, 0);
	assert.deepEqual(compare(a, a).regressed, []);
});
