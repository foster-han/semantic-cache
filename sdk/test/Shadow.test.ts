/**
 * 影子模式：闸全跑，但结果不作数。
 *
 * 上线一个概率型缓存最需要的一步 —— 在真实流量上跑完整条判定链，却仍然每次都真生成，
 * 用来回答「真开了会不会返回错答案」。所以这里测的核心是**只读**：
 * 不复用、不驱逐、不 touch、被降级的那次不写回。一边评估一边按评估结果删数据，
 * 等于用没验证过的判据毁掉证据。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMemoryCacheStore } from "../src/MemoryCacheStore.ts";
import { answering, forCosine, harness } from "./Fakes.ts";

const ASK = { matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} };

test("本会命中时：照常真生成，标出 wouldReuse，且原条目一条不动", async () => {
	const store = createMemoryCacheStore();
	// 先用正常模式灌一条
	const warm = harness({ store });
	await warm.cache.resolve(ASK, answering("原答案"));
	const [before] = await store.all();

	const shadowed = harness({ store, shadow: true });
	const result = await shadowed.cache.resolve(ASK, answering("影子里新生成的"));

	assert.equal(result.outcome, "generated", "影子模式永远不复用");
	assert.equal(result.wouldReuse, true, "但要如实说「本来会命中」");
	assert.equal(result.payload.kind === "answer" && result.payload.answer, "影子里新生成的");

	// 原条目必须原样还在 —— 没被替换、没被驱逐
	const after = await store.all();
	assert.equal(after.length, 1);
	assert.equal(after[0].id, before.id);
	assert.equal(after[0].answer, "原答案");
});

test("真未命中照常写入 —— 否则影子模式下缓存永远暖不起来", async () => {
	const store = createMemoryCacheStore();
	const { cache } = harness({ store, shadow: true });
	const result = await cache.resolve(ASK, answering("第一次"));
	assert.equal(result.wouldReuse, false, "没命中就是没命中，要进影子模式的分母");
	assert.equal((await store.all()).length, 1);

	// 暖起来之后，同一个问题就会被记成「本会命中」
	const again = await cache.resolve(ASK, answering("第二次"));
	assert.equal(again.wouldReuse, true);
	assert.equal((await store.all()).length, 1, "仍然只有一条");
});

test("⑤ 判负时不驱逐 —— 评估不该按未验证的判据删数据", async () => {
	const store = createMemoryCacheStore();
	let version = "v1";
	const warm = harness({ store, sourceVersion: () => version });
	await warm.cache.resolve(ASK, answering("按 v1 写的"));
	assert.equal((await store.all()).length, 1);

	version = "v2";
	const shadowed = harness({ store, shadow: true, sourceVersion: () => version });
	const found = await shadowed.cache.lookup(ASK);
	assert.equal(found.exitedAt, 5, "⑤ 照常判负");
	assert.equal((await store.all()).length, 1, "但条目必须留着");

	// 非影子模式下同样的判定会真的驱逐 —— 对照组
	const real = harness({ store, sourceVersion: () => version });
	await real.cache.lookup(ASK);
	assert.equal((await store.all()).length, 0);
});

test("⑥ 判负时也不驱逐", async () => {
	const store = createMemoryCacheStore();
	const warm = harness({ store });
	await warm.cache.resolve(ASK, answering("原答案"));

	// 答案向量是写入时存下的，改不了；让**片段**编码远离才能让 ⑥ 判负
	const shadowed = harness({ store, shadow: true, passage: { "CHUNK n1": forCosine(0.1) } });
	const found = await shadowed.cache.lookup(ASK);
	assert.equal(found.exitedAt, 6);
	assert.equal((await store.all()).length, 1, "⑥ 的驱逐是破坏性的，影子模式下必须挡住");
});

test("lookup 在影子模式下把命中降级成 shadow，真实判定留在 wouldHave", async () => {
	const store = createMemoryCacheStore();
	await harness({ store }).cache.resolve(ASK, answering("原答案"));

	const found = await harness({ store, shadow: true }).cache.lookup(ASK);
	assert.equal(found.outcome, "shadow");
	assert.equal(found.wouldHave, "exact", "逐字相同，本来是 ② 精确命中");
	assert.notEqual(found.payload, null, "载荷仍然给出来 —— 调用方要能比较新旧答案");
});

test("非影子模式下 wouldReuse 恒为 null —— 别让它污染影子模式的分母", async () => {
	const { cache } = harness();
	const first = await cache.resolve(ASK, answering("a"));
	assert.equal(first.wouldReuse, null);
	const second = await cache.resolve(ASK, answering("不该被调用"));
	assert.equal(second.outcome, "exact");
	assert.equal(second.wouldReuse, null);
});
