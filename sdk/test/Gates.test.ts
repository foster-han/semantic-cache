/**
 * 六道闸的判定。
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
	assert.equal(cold.chunks, null, "没走到 ⑥ 时 chunks 必须是 null，好让调用方知道要自己检索");

	const { cache } = harness({ pair: { "问题 B": forCosine(0.2) }, recallFloor: 0.9 });
	await cache.resolve(P, async () => ({ kind: "answer", answer: "A", sourceIds: ["n1"] }));
	const low = await cache.lookup({ matchText: "问题 B", retrievalText: "问题 B", context: {} });
	assert.equal(low.exitedAt, 3);
	assert.equal(low.support, null);
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

test("⑥ 的算子是 top-1：旧答案自己的来源还在 top-k 里也不能救它（取 max 会漏）", async () => {
	// Vapnik → Breiman 那次的形状：问 Breiman，检索回来的第一篇换了，
	// 但缓存答案的来源文档仍排在第二位，和自己比当然满分。
	let chunks: Array<Chunk> = [{ id: "own", text: "CHUNK own" }];
	const { cache, store } = harness({
		passage: { "旧答案": BASE, "CHUNK own": BASE, "CHUNK other": forCosine(0.5) },
		retrieve: () => chunks.map(c => ({ ...c })),
		support: { high: 0.9, low: 0.8 },
		recallFloor: 0.1,
	});
	await cache.resolve(P, async () => ({ kind: "answer", answer: "旧答案", sourceIds: ["own"] }));
	chunks = [{ id: "other", text: "CHUNK other" }, { id: "own", text: "CHUNK own" }];

	const found = await cache.lookup(P);
	assert.equal(found.exitedAt, 6, "top-1 换了一篇就该拦下 —— 取 max 会被自己的来源顶到 1.0");
	closeTo(found.support, 0.5, "支撑度必须来自 top-1 那一篇");
	assert.equal((await store.all()).length, 0, "判定为无效的条目要驱逐");
});

test("⑥ 判不了 ≠ 判定为无效：检索没返回片段时不复用，但**不驱逐**", async () => {
	const { cache, store } = harness({ retrieve: () => [] });
	await cache.resolve(P, async () => ({ kind: "answer", answer: "A", sourceIds: ["n1"] }));
	const seeded = (await store.all()).length;
	assert.equal(seeded, 1);

	const found = await cache.lookup(P);
	assert.equal(found.exitedAt, 6);
	assert.equal(found.support, null, "没算出支撑度就该是 null，不是 0");
	assert.match(found.trace.find(t => t.gate === 6)?.detail ?? "", /判不了/u);
	assert.equal((await store.all()).length, 1, "一次检索故障不能顺手删掉它读到的缓存");
});

test("⑥ 关掉时照常算分并标 would-exit —— 一次运行就能看出关掉会怎样", async () => {
	const { cache, store } = harness({
		gates: { answerCheck: false },
		passage: { A: BASE, [DEFAULT_CHUNK.text]: forCosine(0.1) },
	});
	await cache.resolve(P, async () => ({ kind: "answer", answer: "A", sourceIds: ["n1"] }));
	const found = await cache.lookup(P);
	assert.equal(found.outcome, "exact");
	const gate6 = found.trace.find(t => t.gate === 6);
	assert.equal(gate6?.verdict, "off");
	assert.ok((gate6?.score ?? 1) < 0.2, "分数照算，好让 A/B 看清代价");
	assert.match(gate6?.detail ?? "", /本该拦下/u);
	assert.equal((await store.all()).length, 1);
});

test("plan 条目：⑤⑥ 都不适用，标 off 并直接复用", async () => {
	const { cache } = harness();
	const plan = async () => ({ kind: "plan" as const, plan: { tool: "getGrade", assignment: "2" } });
	const first = await cache.resolve(P, plan);
	assert.equal(first.outcome, "generated");
	const second = await cache.resolve(P, plan);
	assert.equal(second.outcome, "exact");
	assert.deepEqual(verdicts(second.trace)[5], "off");
	assert.deepEqual(verdicts(second.trace)[6], "off");
	assert.equal(second.payload.kind, "plan");
	assert.equal(second.sourceIds.length, 0);
});
