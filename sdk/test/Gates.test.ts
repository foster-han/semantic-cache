/**
 * 五道闸的判定。
 *
 * 每个测试对应一次实测踩过的坑，或一条被写进 DESIGN 的不变式 —— 它们此前只由散文
 * 守着，改一行实现不会有任何东西变红。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { CacheEntry, InspectableCacheStore } from "../src/types/CacheStore.ts";
import type { Chunk } from "../src/types/Retrieval.ts";
import { BASE, closeTo, DEFAULT_CHUNK, forCosine, harness, verdicts } from "./Fakes.ts";

const P = { matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} };

test("② 精确匹配：逐字相同直接命中，且不必付召回向量那次编码", async () => {
	const { cache, counts } = harness();
	await cache.resolve(P, async () => ({ kind: "answer", answer: "A", sourceIds: ["n1"] }));
	const before = counts.questions;
	const again = await cache.resolve(P, async () => ({ kind: "answer", answer: "不该被调用", sourceIds: ["n1"] }));
	assert.equal(again.outcome, "exact");
	assert.equal(verdicts(again.trace)[2], "hit");
	assert.equal(counts.questions, before, "② 命中的路径不该再编一次召回向量");
});

test("② 哈希碰撞：哈希命中但原文不符时按未命中处理，不返回无关答案", async () => {
	const { cache: seedCache, store } = harness();
	await seedCache.resolve(P, async () => ({ kind: "answer", answer: "过拟合的答案", sourceIds: ["n1"] }));
	const [seeded] = await store.all();

	// 存储实现「自觉比对原文」是不能依赖的，所以库自己再比一次 —— 这里伪造一个
	// 永远返回那条已有条目的 getByHash，然后拿一句完全不同的话去问
	const colliding: InspectableCacheStore = { ...store, async getByHash(): Promise<CacheEntry | null> { return seeded; } };
	const { cache } = harness({ store: colliding, pair: { "另一个问题": forCosine(0.1) } });
	const result = await cache.lookup({ matchText: "另一个问题", retrievalText: "另一个问题", context: {} });
	const trace = result.trace.find(t => t.gate === 2);
	assert.equal(trace?.verdict, "miss");
	assert.match(trace?.detail ?? "", /碰撞/u);
	assert.equal(result.outcome, "miss");
});

test("③ 向量召回：没有候选、或最高余弦低于下限，都在这里退出", async () => {
	const empty = harness();
	const cold = await empty.cache.lookup(P);
	assert.equal(cold.exitedAt, 3);

	const { cache } = harness({ pair: { "问题 B": forCosine(0.2) }, recallFloor: 0.9 });
	await cache.resolve(P, async () => ({ kind: "answer", answer: "A", sourceIds: ["n1"] }));
	const low = await cache.lookup({ matchText: "问题 B", retrievalText: "问题 B", context: {} });
	assert.equal(low.exitedAt, 3);
});

test("④ 精排：不提供 RerankStage 就是没有这道闸（标 off，不拿它的闸值去卡余弦）", async () => {
	const { cache } = harness({ recallFloor: 0.1 });
	await cache.resolve(P, async () => ({ kind: "answer", answer: "A", sourceIds: ["n1"] }));
	const found = await cache.lookup({ matchText: "另一句话", retrievalText: "另一句话", context: {} });
	assert.equal(verdicts(found.trace)[4], "off");
	assert.equal(found.outcome, "reuse", "问题侧此时只由 ③ 的召回下限把关");
});

test("④ 精排：分数低于闸值就在这里退出，且 detail 带上标定出处", async () => {
	const { cache } = harness({ recallFloor: 0.1, rerank: { [P.matchText]: 0.2 }, rerankFloor: 0.5 });
	await cache.resolve(P, async () => ({ kind: "answer", answer: "A", sourceIds: ["n1"] }));
	const found = await cache.lookup({ matchText: "另一句话", retrievalText: "另一句话", context: {} });
	assert.equal(found.exitedAt, 4);
	assert.match(found.trace.find(t => t.gate === 4)?.detail ?? "", /标定于/u);
});

test("④ target: \"answer\" 时打分的是缓存的答案，不是缓存的问题", async () => {
	// 表按**答案**文本建键。实现要是还在传 matchText，这张表就查不到、落到 fallback 1 而过闸
	const byAnswer = { rerank: { 缓存的答案: 0.2 }, rerankFloor: 0.5, recallFloor: 0.1 };
	const answerForm = harness({ ...byAnswer, rerankTarget: "answer" });
	await answerForm.cache.resolve(P, async () => ({ kind: "answer", answer: "缓存的答案", sourceIds: ["n1"] }));
	const blocked = await answerForm.cache.lookup({ matchText: "另一句话", retrievalText: "另一句话", context: {} });
	assert.equal(blocked.exitedAt, 4, "0.2 < 0.5，该在 ④ 退出 —— 说明 candidate 用的是答案文本");
	assert.match(blocked.trace.find(t => t.gate === 4)?.detail ?? "", /问↔答尺度/u);

	// 同一张表在问↔问形态下查不到（键是答案文本），所以不该退出 —— 两个形态确实在比不同的东西
	const questionForm = harness({ ...byAnswer, rerankTarget: "question" });
	await questionForm.cache.resolve(P, async () => ({ kind: "answer", answer: "缓存的答案", sourceIds: ["n1"] }));
	const passed = await questionForm.cache.lookup({ matchText: "另一句话", retrievalText: "另一句话", context: {} });
	assert.notEqual(passed.exitedAt, 4);
	assert.match(passed.trace.find(t => t.gate === 4)?.detail ?? "", /问↔问尺度/u);
});

test("④ target: \"answer\" 遇到 plan 条目：这道闸不适用，不是把它淘汰", async () => {
	/**
	 * plan 条目的 `answer` 是空串。拿空串去打分会必然低分、把 plan 全拦掉；
	 * 回落到 matchText 则是拿问↔答标定的 θq 去卡问↔问的分数。两条都不行 ——
	 * 和 ⑤⑥ 对 plan 不适用是同一个道理，所以标 off 并保留 ③ 的名次。
	 */
	const { cache } = harness({
		recallFloor: 0.1,
		// 空串键值给 0（若实现真拿空串去打分，就会低于闸值而退出，测试随即变红）
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

test("④ 精排推翻 ③ 的名次时，胜出者自己的 ③ 余弦必须报在 trace 上", async () => {
	/**
	 * ③ 的下限只卡 `candidates[0]` —— 那是「这批候选值不值得看」的门槛，不是
	 * 「每条候选都得过」。所以精排完全可以选中一条余弦远低于 floor 的候选，这是
	 * 设计使然（④ 就是用来推翻 ③ 的名次的）。
	 *
	 * 但先前 trace 上只有 top-1 的余弦和精排分，「被复用的那条 ③ 只有 0.3」这件事
	 * 在哪儿都看不到 —— 取舍可以，但必须看得见。
	 */
	const { cache } = harness({
		recallFloor: 0.9,
		pair: { 好候选: forCosine(0.95), 差候选: forCosine(0.3), [P.matchText]: [...BASE] },
		rerank: { 好候选: 0.1, 差候选: 0.99 },
		rerankFloor: 0.5,
	});
	await cache.write({ matchText: "好候选", retrievalText: "好候选", context: {} }, { kind: "answer", answer: "好答案", sourceIds: ["n1"] });
	await cache.write({ matchText: "差候选", retrievalText: "差候选", context: {} }, { kind: "answer", answer: "差答案", sourceIds: ["n1"] });

	const found = await cache.lookup(P);
	assert.equal(found.outcome, "reuse");
	assert.equal(found.payload?.kind === "answer" ? found.payload.answer : "", "差答案", "精排选的是余弦 0.3 那条");
	const four = found.trace.find(t => t.gate === 4)?.detail ?? "";
	assert.match(four, /0\.3000/u, "胜出者的 ③ 余弦要出现在 ④ 的 detail 里");
	assert.match(four, /低于召回下限/u, "低于下限这件事要醒目，不能只报个数");
	// ③ 那一步照旧只报 top-1 —— 它回答的是「这批候选值不值得看」
	closeTo(found.trace.find(t => t.gate === 3)?.score ?? null, 0.95);
});

test("④ target: \"answer\" 的混合 scope：plan 让位给 answer，而且 trace 要说出来", async () => {
	/**
	 * 「这道闸对 plan 不适用」在混合 scope 里等于「让位」：只要 top-k 里还有一条
	 * answer，胜出者就在 answer 里挑 —— plan 条目连 ③ 排第一也拿不到这一次复用。
	 *
	 * 没有第四种选择（让 plan 拿余弦跟 answer 的精排分排同一张榜，就是尺度混用
	 * 换个地方混）。所以取舍是「answer 优先」，代价写在 trace 上：用得着 plan 的
	 * 调用方应当给它单独的 scope。
	 */
	const { cache } = harness({
		recallFloor: 0.5,
		pair: { 计划的问法: forCosine(0.99), 答案的问法: forCosine(0.7), [P.matchText]: [...BASE] },
		rerank: {},
		rerankFloor: 0.1,
		rerankTarget: "answer",
	});
	// 直接 write，免得第二次写入自己先命中了第一条
	await cache.write({ matchText: "计划的问法", retrievalText: "计划的问法", context: {} }, { kind: "plan", plan: { tool: "getGrade" } });
	await cache.write({ matchText: "答案的问法", retrievalText: "答案的问法", context: {} }, { kind: "answer", answer: "答案条目", sourceIds: ["n1"] });

	const found = await cache.lookup(P);
	assert.equal(found.payload?.kind, "answer", "③ 排第一的是 plan，复用的却是 answer");
	const four = found.trace.find(t => t.gate === 4)?.detail ?? "";
	assert.match(four, /让位/u, "被挤掉这件事必须在 trace 上，不能只说「不适用」");
	assert.match(four, /1 条 plan/u);
});

test("⑤ 资料版本：不符就驱逐；关掉这道闸时标 would-exit 并照常放行", async () => {
	let version = "v1";
	const stale = { sourceVersion: () => version };
	const on = harness(stale);
	await on.cache.resolve(P, async () => ({ kind: "answer", answer: "A", sourceIds: ["n1"] }));
	version = "v2";
	const blocked = await on.cache.lookup(P);
	assert.equal(blocked.exitedAt, 5);
	assert.equal((await on.store.all()).length, 0, "版本已过期的条目读到就该消失");

	version = "v1";
	const off = harness({ ...stale, gates: { sourceVersion: false } });
	await off.cache.resolve(P, async () => ({ kind: "answer", answer: "A", sourceIds: ["n1"] }));
	version = "v2";
	const passed = await off.cache.lookup(P);
	assert.equal(passed.outcome, "exact");
	assert.equal(verdicts(passed.trace)[5], "would-exit", "关掉的闸要如实标出「本会拦下」");
});

test("plan 条目：⑤ 不适用，标 off 并直接复用", async () => {
	const { cache } = harness();
	const plan = async () => ({ kind: "plan" as const, plan: { tool: "getGrade", assignment: "2" } });
	const first = await cache.resolve(P, plan);
	assert.equal(first.outcome, "generated");
	const second = await cache.resolve(P, plan);
	assert.equal(second.outcome, "exact");
	assert.deepEqual(verdicts(second.trace)[5], "off");
	assert.equal(second.payload.kind, "plan");
	assert.equal(second.sourceIds.length, 0);
});
