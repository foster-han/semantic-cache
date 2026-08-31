/**
 * 中带（support 落在 low 与 high 之间）的处理。
 *
 * 这一族测试全部围绕同一条不变式：**替换一条缓存，要先写成新的才能删旧的。**
 * 反过来（先删后写）的实现里，生成抛错、写入抛错、产物没有资料依据，任何一种
 * 都会让旧条目白白消失 —— 实测过，一次生成失败净丢一条本来还能用的缓存。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { CacheEntry, InspectableCacheStore } from "../src/types/CacheStore.ts";
import type { CachedPayload } from "../src/types/Pipeline.ts";
import { BASE, closeTo, DEFAULT_CHUNK, forCosine, harness } from "./Fakes.ts";

const P = { matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} };

/** 支撑度恰好 0.85，落在 low 0.8 与 high 0.9 之间 */
function midHarness(extra: Parameters<typeof harness>[0] = {}) {
	return harness({
		passage: { 旧答案: BASE, 新答案: BASE, 微调答案: BASE, [DEFAULT_CHUNK.text]: forCosine(0.85) },
		support: { high: 0.9, low: 0.8 },
		...extra,
	});
}

const seed = async (): Promise<CachedPayload> => ({ kind: "answer", answer: "旧答案", sourceIds: ["n1"] });

test("lookup 走到中带时既不复用也不驱逐 —— 它没失效，只是不够有把握", async () => {
	const { cache, store } = midHarness();
	await cache.resolve(P, seed);
	const found = await cache.lookup(P);
	assert.equal(found.outcome, "mid");
	closeTo(found.support, 0.85);
	assert.equal(found.exitedAt, null);
	assert.ok(found.chunks && found.chunks.length === 1, "走到过 ⑥ 就该把片段带出来，别让调用方再检索一遍");
	assert.equal((await store.all()).length, 1);
});

test("中带 + 无 refine + 生成抛错：旧条目必须还在", async () => {
	const { cache, store } = midHarness();
	await cache.resolve(P, seed);
	const [before] = await store.all();

	await assert.rejects(
		cache.resolve(P, async () => {
			throw new Error("LLM 挂了");
		}),
		/LLM 挂了/u,
	);
	const after = await store.all();
	assert.equal(after.length, 1, "生成失败不该改变缓存状态");
	assert.equal(after[0].id, before.id);
});

test("中带 + 无 refine + 生成结果没有资料依据：不写入，旧条目保留", async () => {
	const { cache, store } = midHarness();
	await cache.resolve(P, seed);
	const [before] = await store.all();

	const result = await cache.resolve(P, async () => ({ kind: "answer", answer: "无依据的答案", sourceIds: [] }));
	assert.equal(result.outcome, "generated");
	assert.equal(result.entryId, null, "null 的含义是「生成了，但没落缓存」");
	assert.equal(result.exitedAt, 6);
	const after = await store.all();
	assert.equal(after.length, 1);
	assert.equal(after[0].id, before.id, "检索故障期间既不删也不写");
	assert.match(result.trace.at(-1)?.detail ?? "", /旧条目因此保留/u);
});

test("中带 + 无 refine + 生成成功：新条目写入，旧条目才被删", async () => {
	const { cache, store } = midHarness();
	await cache.resolve(P, seed);
	const [before] = await store.all();

	const result = await cache.resolve(P, async () => ({ kind: "answer", answer: "新答案", sourceIds: ["n1"] }));
	assert.equal(result.outcome, "generated");
	const after = await store.all();
	assert.equal(after.length, 1, "替换完只剩一条");
	assert.equal(after[0].id, result.entryId);
	assert.notEqual(after[0].id, before.id);
	assert.equal(after[0].answer, "新答案");
});

test("中带 + refine 结果没有依据：不写回，旧条目保留", async () => {
	const { cache, store } = midHarness({
		refine: async () => ({ kind: "answer", answer: "微调答案", sourceIds: [] }),
	});
	await cache.resolve(P, seed);
	const [before] = await store.all();

	const result = await cache.resolve(P, seed);
	assert.equal(result.outcome, "refine");
	assert.equal(result.entryId, before.id, "旧条目还在，返回的就该是它的 id");
	const after = await store.all();
	assert.equal(after.length, 1);
	assert.equal(after[0].answer, "旧答案");
});

test("中带 + refine 成功：写回替换，返回的 entryId 指向现存的那一条", async () => {
	const { cache, store } = midHarness({
		refine: async () => ({ kind: "answer", answer: "微调答案", sourceIds: ["n1"] }),
	});
	await cache.resolve(P, seed);
	const [before] = await store.all();

	const result = await cache.resolve(P, seed);
	assert.equal(result.outcome, "refine");
	const after = await store.all();
	assert.equal(after.length, 1);
	assert.equal(after[0].id, result.entryId);
	assert.notEqual(after[0].id, before.id);
	assert.equal(after[0].answer, "微调答案");
	// 返回旧 id 的话，调用方拿它去 get 只会拿到 null
	assert.ok(await cache.get(result.entryId ?? ""), "entryId 必须能取回条目");
});

test("中带 + refine 成功但写入失败：旧条目必须还在", async () => {
	const memory = midHarness().store;
	let failNext = false;
	const flaky: InspectableCacheStore = {
		...memory,
		async put(entry: CacheEntry): Promise<void> {
			if (failNext) throw new Error("存储写入失败");
			await memory.put(entry);
		},
	};
	const { cache } = midHarness({
		store: flaky,
		refine: async () => ({ kind: "answer", answer: "微调答案", sourceIds: ["n1"] }),
	});
	await cache.resolve(P, seed);
	const [before] = await flaky.all();

	failNext = true;
	await assert.rejects(cache.resolve(P, seed), /存储写入失败/u);
	const after = await flaky.all();
	assert.equal(after.length, 1);
	assert.equal(after[0].id, before.id);
	assert.equal(after[0].answer, "旧答案");
});

test("支撑度 ≥ high 才直接复用；< low 才驱逐", async () => {
	const confident = harness({
		passage: { 旧答案: BASE, [DEFAULT_CHUNK.text]: forCosine(0.95) },
		support: { high: 0.9, low: 0.8 },
	});
	await confident.cache.resolve(P, seed);
	assert.equal((await confident.cache.lookup(P)).outcome, "exact");

	const doomed = harness({
		passage: { 旧答案: BASE, [DEFAULT_CHUNK.text]: forCosine(0.4) },
		support: { high: 0.9, low: 0.8 },
	});
	await doomed.cache.resolve(P, seed);
	const found = await doomed.cache.lookup(P);
	assert.equal(found.outcome, "miss");
	assert.equal(found.exitedAt, 6);
	assert.equal((await doomed.store.all()).length, 0);
});
