/**
 * 写入路径与存储契约。
 *
 * 「什么不写」和「写进去还能不能读回来」是这一层的全部 —— 而这两件事出错都不报错：
 * 没有依据的答案会稳稳顶掉一条好缓存；同 (scope, hash) 取哪一条不确定的话，
 * 换个存储后端 ② 命中的就是另一个答案。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMemoryCacheStore } from "../src/MemoryCacheStore.ts";
import type { CacheEntry } from "../src/types/CacheStore.ts";
import type { CachedPayload } from "../src/types/Pipeline.ts";
import { harness } from "./Fakes.ts";

const P = { matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} };

test("没有任何资料依据的 answer 不写入 —— 否则它会顶掉那条本来好好的旧缓存", async () => {
	const { cache, store } = harness();
	const result = await cache.resolve(P, async () => ({ kind: "answer", answer: "查不到资料", sourceIds: [] }));
	assert.equal(result.outcome, "generated");
	assert.equal(result.entryId, null);
	assert.equal((await store.all()).length, 0);
	assert.match(result.trace.at(-1)?.detail ?? "", /不写入缓存/u);
});

test("plan 条目本来就没有 sourceIds，照写", async () => {
	const { cache, store } = harness();
	const result = await cache.resolve(P, async () => ({ kind: "plan", plan: { tool: "t" } }));
	assert.equal(result.entryId, (await store.all())[0].id);
});

test("writeMany 是两次批量编码，不是 2N 次单条调用", async () => {
	const { cache, counts, store } = harness();
	const items = ["问题 1", "问题 2", "问题 3"].map(q => ({
		prompt: { matchText: q, retrievalText: q, context: {} },
		payload: { kind: "answer" as const, answer: `${q} 的答案`, sourceIds: ["n1"] },
	}));
	await cache.writeMany(items);
	assert.equal((await store.all()).length, 3);
	assert.equal(counts.questions, 1, "三条的召回向量应当一次编完");
	assert.equal(counts.passage, 1, "三条的答案向量也是一次");
});

test("per-entry ttlMs 覆盖全局；null 表示不过期", async () => {
	const clock = { t: 1_000 };
	const { cache, store } = harness({ ttlMs: 60_000, now: () => clock.t });
	const short = await cache.write(P, { kind: "answer", answer: "短", sourceIds: ["n1"] }, { ttlMs: 10 });
	const forever = await cache.write(
		{ matchText: "另一问", retrievalText: "另一问", context: {} },
		{ kind: "answer", answer: "长", sourceIds: ["n1"] },
		{ ttlMs: null },
	);
	const global = await cache.write(
		{ matchText: "第三问", retrievalText: "第三问", context: {} },
		{ kind: "answer", answer: "默认", sourceIds: ["n1"] },
	);
	assert.equal(short.expiresAt, 1_010);
	assert.equal(forever.expiresAt, null);
	assert.equal(global.expiresAt, 61_000);

	clock.t = 2_000;
	assert.equal(await cache.get(short.id), null, "过期条目在读路径上看不见");
	assert.ok(await cache.get(forever.id));
	assert.equal((await store.all()).length, 3, "但 all() 要看得见已过期未清理的");
	assert.equal(await cache.purgeExpired(), 1);
	assert.equal((await store.all()).length, 2);
});

test("同 (scope, matchHash) 有多条时取最新 —— 同毫秒则取 id 大的", async () => {
	const store = createMemoryCacheStore({ now: () => 5_000 });
	const base: Omit<CacheEntry, "id" | "createdAt"> = {
		scope: "course:1",
		matchText: "同一句话",
		matchHash: "h",
		matchVector: [1, 0, 0],
		kind: "answer",
		answer: "",
		plan: {},
		answerVector: [1, 0, 0],
		sourceIds: ["n1"],
		sourceVersion: "v1",
		expiresAt: null,
	};
	await store.put({ ...base, id: "a", createdAt: 1_000, answer: "旧" });
	await store.put({ ...base, id: "b", createdAt: 2_000, answer: "新" });
	assert.equal((await store.getByHash("course:1", "h"))?.answer, "新");

	await store.clear();
	await store.put({ ...base, id: "aaa", createdAt: 1_000, answer: "同毫秒 小 id" });
	await store.put({ ...base, id: "zzz", createdAt: 1_000, answer: "同毫秒 大 id" });
	assert.equal((await store.getByHash("course:1", "h"))?.answer, "同毫秒 大 id");

	// id 重复必须抛错：静默丢弃会让一条缓存凭空消失，覆盖则会改写别的进程写的内容
	await assert.rejects(store.put({ ...base, id: "zzz", createdAt: 9_000 }), /id 重复/u);
});

test("all() 按 createdAt 升序、同毫秒按 id —— 三种后端必须给同一个顺序", async () => {
	const store = createMemoryCacheStore();
	const base: Omit<CacheEntry, "id" | "createdAt" | "matchHash"> = {
		scope: "course:1",
		matchText: "x",
		matchVector: [1, 0, 0],
		kind: "answer",
		answer: "a",
		plan: {},
		answerVector: [1, 0, 0],
		sourceIds: ["n1"],
		sourceVersion: "v1",
		expiresAt: null,
	};
	// 故意最后写入 createdAt 最早的那条 —— 插入顺序与契约顺序在这里分叉
	await store.put({ ...base, id: "b", matchHash: "h1", createdAt: 2_000 });
	await store.put({ ...base, id: "zzz", matchHash: "h2", createdAt: 3_000 });
	await store.put({ ...base, id: "mmm", matchHash: "h3", createdAt: 3_000 });
	await store.put({ ...base, id: "a", matchHash: "h4", createdAt: 1_000 });
	assert.deepEqual((await store.all()).map(e => e.id), ["a", "b", "mmm", "zzz"]);
});

test("singleFlight：并发的同一个问题只生成一次；关掉后各自生成", async () => {
	let calls = 0;
	const slow = async (): Promise<CachedPayload> => {
		calls += 1;
		await new Promise(r => setTimeout(r, 5));
		return { kind: "answer", answer: "A", sourceIds: ["n1"] };
	};
	const merged = harness();
	await Promise.all([merged.cache.resolve(P, slow), merged.cache.resolve(P, slow), merged.cache.resolve(P, slow)]);
	assert.equal(calls, 1, "三个并发未命中只该走一次完整流程");
	assert.equal((await merged.store.all()).length, 1, "更不该写出三条重复条目");

	calls = 0;
	const separate = harness({ singleFlight: false });
	await Promise.all([separate.cache.resolve(P, slow), separate.cache.resolve(P, slow)]);
	assert.equal(calls, 2);
});

test("合流键里必须带 retrievalText —— 否则等于亲手制造占位符塌陷", async () => {
	let calls = 0;
	const slow = async (): Promise<CachedPayload> => {
		calls += 1;
		await new Promise(r => setTimeout(r, 5));
		return { kind: "answer", answer: "A", sourceIds: ["n1"] };
	};
	const { cache } = harness({ scope: () => ({ key: "user:x", shared: false }) });
	// 匿名化之后两个学生的 matchText 完全相同，实体只在 retrievalText 里
	await Promise.all([
		cache.resolve({ matchText: "<PERSON_1> 的分数", retrievalText: "张三的分数", context: {} }, slow),
		cache.resolve({ matchText: "<PERSON_1> 的分数", retrievalText: "李四的分数", context: {} }, slow),
	]);
	assert.equal(calls, 2, "这两个请求不是同一个问题，不能合流");
});

test("失效：evict 收数组、clear 按 scope、invalidateSource 按资料 id", async () => {
	const { cache, store } = harness({ scope: prompt => `course:${prompt.context.courseId ?? "-"}` });
	const written = await cache.writeMany(
		[
			{ q: "问题 1", src: ["n1"], course: "1" },
			{ q: "问题 2", src: ["n1", "n2"], course: "1" },
			{ q: "问题 3", src: ["n2"], course: "2" },
		].map(x => ({
			prompt: { matchText: x.q, retrievalText: x.q, context: { courseId: x.course } },
			payload: { kind: "answer" as const, answer: "a", sourceIds: x.src },
		})),
	);
	assert.equal(await cache.invalidateSource("n1"), 2, "引用过这篇资料的都该失效");
	assert.equal((await store.all()).length, 1);
	assert.equal(await cache.clear("course:2"), 1);
	assert.equal((await store.all()).length, 0);

	await cache.writeMany(
		["问题 4", "问题 5"].map(q => ({
			prompt: { matchText: q, retrievalText: q, context: { courseId: "1" } },
			payload: { kind: "answer" as const, answer: "a", sourceIds: ["n9"] },
		})),
	);
	await cache.evict((await store.all()).map(e => e.id));
	assert.equal((await store.all()).length, 0);
	assert.ok(written.length === 3);
});
