/**
 * What the four gates decide.
 *
 * Each test corresponds to a trap hit in real measurement, or to an invariant written into
 * DESIGN — ones that until now were guarded by prose alone, where changing a line of the
 * implementation turned nothing red.
 */

import type { CacheEntry, InspectableCacheStore } from "../src/types/CacheStore.ts";
import { BASE, closeTo, forCosine, harness, verdicts } from "./Fakes.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const P = { matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} };

test("② exact match: byte-identical hits directly, without paying for the recall embedding", async () => {
	const { cache, counts } = harness();
	await cache.resolve(P, async () => ({ kind: "answer", answer: "A" }));
	const before = counts.questions;
	const again = await cache.resolve(P, async () => ({ kind: "answer", answer: "不该被调用" }));
	assert.equal(again.outcome, "exact");
	assert.equal(verdicts(again.trace)[2], "hit");
	assert.equal(counts.questions, before, "② 命中的路径不该再编一次召回向量");
});

test("② hash collision: a hash hit whose original text differs is treated as a miss, never returning an unrelated answer", async () => {
	const { cache: seedCache, store } = harness();
	await seedCache.resolve(P, async () => ({ kind: "answer", answer: "过拟合的答案" }));
	const [seeded] = await store.all();

	// A store that compares the original text of its own accord cannot be relied on, so the
	// library compares again itself. Here a fake getByHash always returns the one existing entry,
	// and the question asked is something entirely different.
	const colliding: InspectableCacheStore = {
		...store,
		getByHash(): Promise<CacheEntry | null> {
			return Promise.resolve(seeded);
		},
	};
	const { cache } = harness({ store: colliding, pair: { 另一个问题: forCosine(0.1) } });
	const result = await cache.lookup({ matchText: "另一个问题", retrievalText: "另一个问题", context: {} });
	const trace = result.trace.find(t => t.gate === 2);
	assert.equal(trace?.verdict, "miss");
	assert.match(trace?.detail ?? "", /collision/u);
	assert.equal(result.outcome, "miss");
});

test("③ vector recall: no candidates, or a top cosine below the floor, both exit here", async () => {
	const empty = harness();
	const cold = await empty.cache.lookup(P);
	assert.equal(cold.exitedAt, 3);

	const { cache } = harness({ pair: { "问题 B": forCosine(0.2) }, recallFloor: 0.9 });
	await cache.resolve(P, async () => ({ kind: "answer", answer: "A" }));
	const low = await cache.lookup({ matchText: "问题 B", retrievalText: "问题 B", context: {} });
	assert.equal(low.exitedAt, 3);
});

test("④ rerank: no RerankStage means no gate (marked off, and its floor is never applied to the cosine)", async () => {
	const { cache } = harness({ recallFloor: 0.1 });
	await cache.resolve(P, async () => ({ kind: "answer", answer: "A" }));
	const found = await cache.lookup({ matchText: "另一句话", retrievalText: "另一句话", context: {} });
	assert.equal(verdicts(found.trace)[4], "off");
	assert.equal(found.outcome, "reuse", "问题侧此时只由 ③ 的召回下限把关");
});

test("④ rerank: a score below the floor exits here, and the detail names where the calibration came from", async () => {
	const { cache } = harness({ recallFloor: 0.1, rerank: { [P.matchText]: 0.2 }, rerankFloor: 0.5 });
	await cache.resolve(P, async () => ({ kind: "answer", answer: "A" }));
	const found = await cache.lookup({ matchText: "另一句话", retrievalText: "另一句话", context: {} });
	assert.equal(found.exitedAt, 4);
	assert.match(found.trace.find(t => t.gate === 4)?.detail ?? "", /calibrated on/u);
});

test('④ target: "answer" 时打分的是缓存的答案，不是缓存的问题', async () => {
	// The table is keyed on the **answer** text. An implementation still passing matchText finds
	// nothing in it, falls back to 1 and passes the gate.
	const byAnswer = { rerank: { 缓存的答案: 0.2 }, rerankFloor: 0.5, recallFloor: 0.1 };
	const answerForm = harness({ ...byAnswer, rerankTarget: "answer" });
	await answerForm.cache.resolve(P, async () => ({ kind: "answer", answer: "缓存的答案" }));
	const blocked = await answerForm.cache.lookup({ matchText: "另一句话", retrievalText: "另一句话", context: {} });
	assert.equal(blocked.exitedAt, 4, "0.2 < 0.5，该在 ④ 退出 —— 说明 candidate 用的是答案文本");
	assert.match(blocked.trace.find(t => t.gate === 4)?.detail ?? "", /question-to-answer scale/u);

	// The same table finds nothing in the question-to-question form, since it is keyed on answer
	// text, so this must not exit — the two forms really do compare different things.
	const questionForm = harness({ ...byAnswer, rerankTarget: "question" });
	await questionForm.cache.resolve(P, async () => ({ kind: "answer", answer: "缓存的答案" }));
	const passed = await questionForm.cache.lookup({ matchText: "另一句话", retrievalText: "另一句话", context: {} });
	assert.notEqual(passed.exitedAt, 4);
	assert.match(passed.trace.find(t => t.gate === 4)?.detail ?? "", /question-to-question scale/u);
});

test('④ target: "answer" 遇到 plan 条目：这道闸不适用，不是把它淘汰', async () => {
	/**
	 * A plan entry's `answer` is the empty string. Scoring the empty string necessarily scores low
	 * and blocks every plan; falling back to matchText applies a θq calibrated on question-to-answer
	 * to a question-to-question score. Neither works — for the same reason ⑤⑥ do not apply to
	 * plans — so the gate is marked off and ③'s ranking stands.
	 */
	const { cache } = harness({
		recallFloor: 0.1,
		// The empty-string key scores 0: an implementation that really scored the empty string would
		// fall below the floor and exit, turning this test red.
		rerank: { "": 0 },
		rerankFloor: 0.5,
		rerankTarget: "answer",
	});
	await cache.resolve(P, async () => ({ kind: "plan" as const, plan: { tool: "getGrade", assignment: "2" } }));
	const found = await cache.lookup({ matchText: "另一句话", retrievalText: "另一句话", context: {} });
	assert.equal(verdicts(found.trace)[4], "off");
	assert.match(found.trace.find(t => t.gate === 4)?.detail ?? "", /plan/u);
	assert.equal(found.outcome, "reuse", "④ 不适用不等于淘汰：plan 条目该照常按 ③ 的名次复用");
});

test("when ④ overturns ③'s ranking, the winner's own ③ cosine must appear in the trace", async () => {
	/**
	 * ③'s floor applies to `candidates[0]` alone — it is the bar for whether this candidate set is
	 * worth looking at, not a requirement every candidate must clear. So rerank may perfectly well
	 * select a candidate whose cosine sits far below the floor; that is by design, since ④ exists
	 * to overturn ③'s ranking.
	 *
	 * But the trace used to carry only the top-1 cosine and the rerank score, leaving the fact that
	 * the reused entry scored just 0.3 at ③ visible nowhere. The trade-off is fine; being invisible
	 * is not.
	 */
	const { cache } = harness({
		recallFloor: 0.9,
		pair: { 好候选: forCosine(0.95), 差候选: forCosine(0.3), [P.matchText]: [...BASE] },
		rerank: { 好候选: 0.1, 差候选: 0.99 },
		rerankFloor: 0.5,
	});
	await cache.write(
		{ matchText: "好候选", retrievalText: "好候选", context: {} },
		{ kind: "answer", answer: "好答案" },
	);
	await cache.write(
		{ matchText: "差候选", retrievalText: "差候选", context: {} },
		{ kind: "answer", answer: "差答案" },
	);

	const found = await cache.lookup(P);
	assert.equal(found.outcome, "reuse");
	assert.equal(found.payload?.kind === "answer" ? found.payload.answer : "", "差答案", "精排选的是余弦 0.3 那条");
	const four = found.trace.find(t => t.gate === 4)?.detail ?? "";
	assert.match(four, /0\.3000/u, "胜出者的 ③ 余弦要出现在 ④ 的 detail 里");
	assert.match(four, /below the recall floor/u, "being below the floor has to stand out, not just be a number");
	// ③'s step still reports the top-1 alone: what it answers is whether the set is worth reading.
	closeTo(found.trace.find(t => t.gate === 3)?.score ?? null, 0.95);
});

test('④ target: "answer" 的混合 scope：plan 让位给 answer，而且 trace 要说出来', async () => {
	/**
	 * In a mixed scope, "this gate does not apply to plans" amounts to yielding: as long as one
	 * answer remains in the top k, the winner is picked from the answers — a plan entry does not get
	 * this reuse even when it ranks first at ③.
	 *
	 * There is no fourth option: ranking a plan's cosine against an answer's rerank score on one
	 * board is the same scale-mixing in a different place. So the trade-off is answers first, with
	 * the cost written on the trace — a caller that needs plans should give them their own scope.
	 */
	const { cache } = harness({
		recallFloor: 0.5,
		pair: { 计划的问法: forCosine(0.99), 答案的问法: forCosine(0.7), [P.matchText]: [...BASE] },
		rerank: {},
		rerankFloor: 0.1,
		rerankTarget: "answer",
	});
	// Write directly, so the second write does not first hit the entry from the first.
	await cache.write(
		{ matchText: "计划的问法", retrievalText: "计划的问法", context: {} },
		{ kind: "plan", plan: { tool: "getGrade" } },
	);
	await cache.write(
		{ matchText: "答案的问法", retrievalText: "答案的问法", context: {} },
		{ kind: "answer", answer: "答案条目" },
	);

	const found = await cache.lookup(P);
	assert.equal(found.payload?.kind, "answer", "③ 排第一的是 plan，复用的却是 answer");
	const four = found.trace.find(t => t.gate === 4)?.detail ?? "";
	assert.match(
		four,
		/yielded to answers/u,
		'being crowded out has to appear in the trace, not just "does not apply"',
	);
	assert.match(four, /1 plan entry\/entries/u);
});

/**
 * **There is no ⑤ any more, and the read path evicts nothing.**
 *
 * ⑤ compared the entry's source-version fingerprint against the current one and deleted the entry
 * on a mismatch. That needed every entry to record the documents it cited — the dimension that has
 * been removed. This test pins the consequence rather than deleting the case: revised material is
 * now invisible to the read path, and the only thing that clears it is `clear()` on the space.
 */
test("revised material: no gate sees it, the old answer keeps being reused, and clearing the space is what ends it", async () => {
	const { cache, store } = harness();
	await cache.resolve(P, async () => ({ kind: "answer", answer: "按旧资料写的" }));
	const again = await cache.lookup(P);
	assert.equal(again.outcome, "exact");
	assert.equal(again.exitedAt, null, "读侧没有任何一道闸会因为资料改版拦下它");
	assert.equal((await store.all()).length, 1, "读路径不删任何条目");
	// The trace stops at ②; nothing runs below it.
	assert.deepEqual(
		again.trace.map(t => t.gate),
		[1, 2],
	);

	assert.equal(await cache.clear({ org: "org:1", key: "course:1" }), 1);
	assert.equal((await cache.lookup(P)).outcome, "miss");
});

test("plan entries are reused directly, like answer entries", async () => {
	const { cache } = harness();
	const plan = async () => ({ kind: "plan" as const, plan: { tool: "getGrade", assignment: "2" } });
	const first = await cache.resolve(P, plan);
	assert.equal(first.outcome, "generated");
	const second = await cache.resolve(P, plan);
	assert.equal(second.outcome, "exact");
	assert.equal(second.payload.kind, "plan");
	assert.equal(second.scope, "org:1|course:1");
});
