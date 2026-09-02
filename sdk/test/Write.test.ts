/**
 * The write path and the store contract.
 *
 * What is refused, and whether what was stored reads back, is all there is at this layer — and
 * both fail silently: if which row wins for the same (scope, hash) is undefined, ② hits a
 * different answer on a different store backend.
 */

import { createMemoryCacheStore } from "../src/MemoryCacheStore.ts";
import type { CacheEntry } from "../src/types/CacheStore.ts";
import type { CachedPayload } from "../src/types/Pipeline.ts";
import { harness } from "./Fakes.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const P = { matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} };

/**
 * **This used to be refused.** While entries recorded which documents they cited, an answer citing
 * nothing was out of reach of both ⑤ and `invalidateSource`, so a retrieval outage would generate
 * one and it would reliably displace a perfectly good older entry — `cacheable()` therefore turned
 * it away. The source dimension is gone, every entry is invalidated the same way (`clear()` on its
 * space), and there is no longer a category of entry that invalidation cannot reach. So the guard
 * had nothing left to discriminate on and went with it.
 *
 * The cost is real and worth naming: a retrieval outage now writes its content-free answers into
 * the cache, and they live until the TTL expires or the space is cleared. `CachePolicy.noStore` is
 * the place to keep them out — the caller can see the outage, the library cannot.
 */
test("an answer with no retrieved chunks behind it is written like any other", async () => {
	const { cache, store } = harness({ retrieve: () => [] });
	const result = await cache.resolve(P, async () => ({ kind: "answer", answer: "查不到资料" }));
	assert.equal(result.outcome, "generated");
	assert.equal(result.entryId, (await store.all())[0].id);
});

test("plan entries are written like answer entries", async () => {
	const { cache, store } = harness();
	const result = await cache.resolve(P, async () => ({ kind: "plan", plan: { tool: "t" } }));
	assert.equal(result.entryId, (await store.all())[0].id);
});

test("writeMany is one batch embedding, not N single calls", async () => {
	const { cache, counts, store } = harness();
	const items = ["问题 1", "问题 2", "问题 3"].map(q => ({
		prompt: { matchText: q, retrievalText: q, context: {} },
		payload: { kind: "answer" as const, answer: `${q} 的答案` },
	}));
	await cache.writeMany(items);
	assert.equal((await store.all()).length, 3);
	assert.equal(counts.questions, 1, "三条的召回向量应当一次编完");
});

test("a per-entry ttlMs overrides the global one; null means it never expires", async () => {
	const clock = { t: 1_000 };
	const { cache, store } = harness({ ttlMs: 60_000, now: () => clock.t });
	const short = await cache.write(P, { kind: "answer", answer: "短" }, { ttlMs: 10 });
	const forever = await cache.write(
		{ matchText: "另一问", retrievalText: "另一问", context: {} },
		{ kind: "answer", answer: "长" },
		{ ttlMs: null },
	);
	const global = await cache.write(
		{ matchText: "第三问", retrievalText: "第三问", context: {} },
		{ kind: "answer", answer: "默认" },
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

test("with several rows for the same (scope, matchHash) the newest wins — within the same millisecond, the larger id", async () => {
	const store = createMemoryCacheStore({ now: () => 5_000 });
	const base: Omit<CacheEntry, "id" | "createdAt"> = {
		scope: "course:1",
		matchText: "同一句话",
		matchHash: "h",
		matchVector: [1, 0, 0],
		kind: "answer",
		answer: "",
		plan: {},
		expiresAt: null,
	};
	await store.put({ ...base, id: "a", createdAt: 1_000, answer: "旧" });
	await store.put({ ...base, id: "b", createdAt: 2_000, answer: "新" });
	assert.equal((await store.getByHash("course:1", "h"))?.answer, "新");

	await store.clear();
	await store.put({ ...base, id: "aaa", createdAt: 1_000, answer: "同毫秒 小 id" });
	await store.put({ ...base, id: "zzz", createdAt: 1_000, answer: "同毫秒 大 id" });
	assert.equal((await store.getByHash("course:1", "h"))?.answer, "同毫秒 大 id");

	// A duplicate id has to throw: dropping it silently makes an entry vanish, and overwriting
	// rewrites what another process wrote.
	await assert.rejects(
		store.put({ ...base, id: "zzz", createdAt: 9_000 }),
		/[Dd]uplicate (cache entry|document) id/u,
	);
});

test("all() orders by createdAt ascending and by id within the same millisecond — all three backends must agree on the order", async () => {
	const store = createMemoryCacheStore();
	const base: Omit<CacheEntry, "id" | "createdAt" | "matchHash"> = {
		scope: "course:1",
		matchText: "x",
		matchVector: [1, 0, 0],
		kind: "answer",
		answer: "a",
		plan: {},
		expiresAt: null,
	};
	// The oldest createdAt is written last on purpose, so insertion order and contract order diverge.
	await store.put({ ...base, id: "b", matchHash: "h1", createdAt: 2_000 });
	await store.put({ ...base, id: "zzz", matchHash: "h2", createdAt: 3_000 });
	await store.put({ ...base, id: "mmm", matchHash: "h3", createdAt: 3_000 });
	await store.put({ ...base, id: "a", matchHash: "h4", createdAt: 1_000 });
	assert.deepEqual(
		(await store.all()).map(e => e.id),
		["a", "b", "mmm", "zzz"],
	);
});

test("singleFlight: the same question asked concurrently generates once; with it off each generates on its own", async () => {
	let calls = 0;
	const slow = async (): Promise<CachedPayload> => {
		calls += 1;
		await new Promise(r => setTimeout(r, 5));
		return { kind: "answer", answer: "A" };
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

test("the merge key must include retrievalText — otherwise you are hand-building a placeholder collapse", async () => {
	let calls = 0;
	const slow = async (): Promise<CachedPayload> => {
		calls += 1;
		await new Promise(r => setTimeout(r, 5));
		return { kind: "answer", answer: "A" };
	};
	const { cache } = harness({ scope: () => ({ key: "user:x", shared: false, org: "org:1" }) });
	// After anonymisation the two students share an identical matchText; the entities live only in
	// retrievalText.
	await Promise.all([
		cache.resolve({ matchText: "<PERSON_1> 的分数", retrievalText: "张三的分数", context: {} }, slow),
		cache.resolve({ matchText: "<PERSON_1> 的分数", retrievalText: "李四的分数", context: {} }, slow),
	]);
	assert.equal(calls, 2, "这两个请求不是同一个问题，不能合流");
});

/**
 * `clear()` by space is the **only** bulk invalidation left. `invalidateSource(id)` used to sit
 * beside it and delete every entry citing one document; per-document association is gone, so the
 * whole space is the unit.
 */
test("invalidation: evict takes an array, clear works by space", async () => {
	const { cache, store } = harness({
		scope: prompt => ({ key: `course:${prompt.context.courseId ?? "-"}`, shared: true, org: "org:1" }),
	});
	const written = await cache.writeMany(
		[
			{ q: "问题 1", course: "1" },
			{ q: "问题 2", course: "1" },
			{ q: "问题 3", course: "2" },
		].map(x => ({
			prompt: { matchText: x.q, retrievalText: x.q, context: { courseId: x.course } },
			payload: { kind: "answer" as const, answer: "a" },
		})),
	);
	// clear takes { org, key } and the library does the joining — passing a string was the old
	// spelling that deleted zero rows without complaint.
	assert.equal(await cache.clear({ org: "org:1", key: "course:1" }), 2, "同一个 space 里的两条一起清掉");
	assert.equal((await store.all()).length, 1);
	assert.equal(await cache.clear({ org: "org:1", key: "course:2" }), 1);
	assert.equal((await store.all()).length, 0);

	await cache.writeMany(
		["问题 4", "问题 5"].map(q => ({
			prompt: { matchText: q, retrievalText: q, context: { courseId: "1" } },
			payload: { kind: "answer" as const, answer: "a" },
		})),
	);
	await cache.evict((await store.all()).map(e => e.id));
	assert.equal((await store.all()).length, 0);
	assert.ok(written.length === 3);
});
