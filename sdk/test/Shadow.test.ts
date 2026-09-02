/**
 * Shadow mode: every gate runs, and none of the verdicts count.
 *
 * The step a probabilistic cache most needs before it ships — run the whole decision chain on
 * real traffic while still generating for real every time, to answer whether turning it on would
 * return a wrong answer. So what is under test here is **read-only**: no reuse, no eviction, no
 * touch, and no write-back on the downgraded request. Deleting data by an evaluation's own
 * verdicts while that evaluation runs destroys the evidence using an unvalidated criterion.
 */

import { createMemoryCacheStore } from "../src/MemoryCacheStore.ts";
import { answering, harness } from "./Fakes.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const ASK = { matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} };

test("on a would-be hit: generate for real as usual, report wouldReuse, and touch no existing entry", async () => {
	const store = createMemoryCacheStore();
	// Seed one entry in normal mode first.
	const warm = harness({ store });
	await warm.cache.resolve(ASK, answering("原答案"));
	const [before] = await store.all();

	const shadowed = harness({ store, shadow: true });
	const result = await shadowed.cache.resolve(ASK, answering("影子里新生成的"));

	assert.equal(result.outcome, "generated", "影子模式永远不复用");
	assert.equal(result.wouldReuse, true, "但要如实说「本来会命中」");
	assert.equal(result.payload.kind === "answer" && result.payload.answer, "影子里新生成的");

	// The original entry has to still be there untouched — neither replaced nor evicted.
	const after = await store.all();
	assert.equal(after.length, 1);
	assert.equal(after[0].id, before.id);
	assert.equal(after[0].answer, "原答案");
});

test("a genuine miss writes as usual — otherwise the cache never warms up in shadow mode", async () => {
	const store = createMemoryCacheStore();
	const { cache } = harness({ store, shadow: true });
	const result = await cache.resolve(ASK, answering("第一次"));
	assert.equal(result.wouldReuse, false, "没命中就是没命中，要进影子模式的分母");
	assert.equal((await store.all()).length, 1);

	// Once warm, the same question is recorded as a would-be hit.
	const again = await cache.resolve(ASK, answering("第二次"));
	assert.equal(again.wouldReuse, true);
	assert.equal((await store.all()).length, 1, "仍然只有一条");
});

/**
 * **This used to be about eviction.** ⑤ deleted an entry whose source version had moved on, and
 * shadow mode had to suppress that — deleting data by the very criterion under evaluation destroys
 * the evidence. ⑤ is gone and nothing on the read path deletes any more, so what is left of "an
 * evaluation must not change what it evaluates" is `touch()`: it feeds `lru`/`lfu` ordering, and
 * counting shadow reads as real uses would let the evaluation decide which entries survive.
 */
test("shadow mode does not touch — otherwise the evaluation rewrites the lru/lfu ordering under test", async () => {
	const store = createMemoryCacheStore({ eviction: { policy: "lru", capacity: 10 } });
	await harness({ store }).cache.resolve(ASK, answering("原答案"));
	const [before] = await store.all();
	assert.equal(before.lastUsedAt, undefined, "写入时不记 lastUsedAt —— 它等于 createdAt，存两遍没有信息");

	const shadowed = harness({ store, shadow: true });
	assert.equal((await shadowed.cache.lookup(ASK)).outcome, "shadow");
	assert.equal((await store.all())[0].lastUsedAt, undefined, "影子模式下不许记账");

	// Outside shadow mode the same read really does keep books — the control.
	await harness({ store }).cache.lookup(ASK);
	assert.notEqual((await store.all())[0].lastUsedAt, undefined);
});

test("in shadow mode lookup downgrades a hit to shadow and leaves the real verdict in wouldHave", async () => {
	const store = createMemoryCacheStore();
	await harness({ store }).cache.resolve(ASK, answering("原答案"));

	const found = await harness({ store, shadow: true }).cache.lookup(ASK);
	assert.equal(found.outcome, "shadow");
	assert.equal(found.wouldHave, "exact", "逐字相同，本来是 ② 精确命中");
	assert.notEqual(found.payload, null, "载荷仍然给出来 —— 调用方要能比较新旧答案");
});

test("outside shadow mode wouldReuse is always null — it must not pollute shadow mode's denominator", async () => {
	const { cache } = harness();
	const first = await cache.resolve(ASK, answering("a"));
	assert.equal(first.wouldReuse, null);
	const second = await cache.resolve(ASK, answering("不该被调用"));
	assert.equal(second.outcome, "exact");
	assert.equal(second.wouldReuse, null);
});
