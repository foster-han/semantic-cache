/**
 * 开关**两两组合**的回归。
 *
 * 这批 bug 全长一个样：policy、shadow、中带、票据每个单独都有测试，组合起来没有。
 * 每加一个正交开关组合数就翻倍，而只有对角线被测过 —— 下面这些是补上的非对角线。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMemoryCacheStore } from "../src/MemoryCacheStore.ts";
import { createStructuralPolicy } from "../src/CachePolicyRules.ts";
import { answering, forCosine, harness } from "./Fakes.ts";

const ASK = { matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} };
const noStore = createStructuralPolicy({ noStoreWhen: { openEnded: "开放生成" } });
const OPEN = { ...ASK, context: { openEnded: "1" } };

/* ---------- F1：不带票据的写入也要过策略 ---------- */

test("F1 write() 不带票据时也要过策略 —— 否则守卫只是建议", async () => {
	const { cache, store } = harness({ policy: noStore });
	await assert.rejects(
		() => cache.write(OPEN, { kind: "answer", answer: "偷偷写进去", sourceIds: ["n1"] }),
		/判定为不进缓存（开放生成）/u,
		"直接 write 是一扇正门，必须也关上",
	);
	assert.equal((await store.all()).length, 0);

	// 放行的 prompt 照常写得进去
	await cache.write(ASK, { kind: "answer", answer: "正常的", sourceIds: ["n1"] });
	assert.equal((await store.all()).length, 1);
});

test("F1 writeMany 里被策略挡住的那条会让整批在落库前抛 —— 不留半批", async () => {
	const { cache, store } = harness({ policy: noStore });
	await assert.rejects(
		() =>
			cache.writeMany([
				{ prompt: ASK, payload: { kind: "answer", answer: "好的", sourceIds: ["n1"] } },
				{ prompt: OPEN, payload: { kind: "answer", answer: "该被挡", sourceIds: ["n1"] } },
			]),
		/判定为不进缓存/u,
	);
	assert.equal((await store.all()).length, 0, "守卫在 put 之前，不该留下污染");
});

/* ---------- F2：影子模式的只读承诺，写路径也得守住 ---------- */

test("F2 影子模式 + ⑤ 判负：resolve 走完也不能把条目顶掉", async () => {
	const store = createMemoryCacheStore();
	let version = "v1";
	await harness({ store, sourceVersion: () => version }).cache.resolve(ASK, answering("按 v1 写的"));
	const [before] = await store.all();

	version = "v2";
	const shadowed = harness({ store, shadow: true, sourceVersion: () => version });
	// 关键：走 resolve 而不是 lookup —— 先前的测试只调 lookup，漏掉了写路径这一半
	const result = await shadowed.cache.resolve(ASK, answering("影子里新生成的"));

	assert.equal(result.outcome, "generated");
	assert.equal(result.wouldReuse, false, "⑤ 判负，本来也不会复用");
	const after = await store.all();
	assert.equal(after.length, 1, "写入的去重会把同 hash 的旧条目当 duplicate 驱逐 —— 必须挡住");
	assert.equal(after[0].id, before.id);
	assert.equal(after[0].answer, "按 v1 写的");
});

test("F2 影子模式 + ⑥ 判负：同上", async () => {
	const store = createMemoryCacheStore();
	await harness({ store }).cache.resolve(ASK, answering("原答案"));
	const [before] = await store.all();

	const shadowed = harness({ store, shadow: true, passage: { "CHUNK n1": forCosine(0.1) } });
	await shadowed.cache.resolve(ASK, answering("影子里新生成的"));

	const after = await store.all();
	assert.equal(after.length, 1);
	assert.equal(after[0].id, before.id);
});

test("F2 影子模式下真未命中照常写 —— 只抑制会撞上去重的那几种", async () => {
	const store = createMemoryCacheStore();
	const { cache } = harness({ store, shadow: true });
	await cache.resolve(ASK, answering("第一次"));
	assert.equal((await store.all()).length, 1, "③ 无候选的真未命中不该被抑制");
});

test("F2 影子模式 + policy bypass：一道闸都没跑，写入也一并跳过", async () => {
	const store = createMemoryCacheStore();
	const policy = createStructuralPolicy({ noCacheWhen: { regenerate: "重新回答" } });
	const { cache } = harness({ store, shadow: true, policy });
	const result = await cache.resolve({ ...ASK, context: { regenerate: "1" } }, answering("影子里的重生成"));
	assert.equal(result.outcome, "bypassed");
	assert.equal((await store.all()).length, 0, "没跑闸就不知道会不会顶掉现有条目，保守不写");
});

/* ---------- F3：noStore + 中带 + refine ---------- */

test("F3 noStore + 中带 + refine：返回微调结果但不写回，不能让拒发的票据炸掉 resolve", async () => {
	const store = createMemoryCacheStore();
	// 先正常灌一条
	await harness({ store }).cache.resolve(ASK, answering("原答案"));
	const [before] = await store.all();

	// 支撑度落进 [low, high) 的微调带 → mid
	const { cache } = harness({
		store,
		policy: noStore,
		passage: { "CHUNK n1": forCosine(0.85) },
		support: { high: 0.9, low: 0.8 },
		refine: async () => ({ kind: "answer" as const, answer: "微调过的", sourceIds: ["n1"] }),
	});
	const result = await cache.resolve(OPEN, answering("不该走到完整生成"));

	assert.equal(result.outcome, "refine");
	assert.equal(result.payload.kind === "answer" && result.payload.answer, "微调过的");
	const after = await store.all();
	assert.equal(after.length, 1);
	assert.equal(after[0].answer, "原答案", "noStore 下微调结果只用这一次，旧条目原样保留");
	assert.equal(after[0].id, before.id);
});

/* ---------- F5：shadow 分支必须排在 noStore 之前 ---------- */

test("F5 shadow + noStore + 本会命中：wouldReuse 必须是 true", async () => {
	const store = createMemoryCacheStore();
	await harness({ store }).cache.resolve(ASK, answering("原答案"));

	const { cache } = harness({ store, shadow: true, policy: noStore });
	const result = await cache.resolve(OPEN, answering("影子里新生成的"));
	// noStore 只管写不管读 —— 它本来是会复用的，报 false 会低估影子模式的分子
	assert.equal(result.wouldReuse, true);
	assert.equal((await store.all()).length, 1);
});

/* ---------- F6：exitedAt 在各分支上一致 ---------- */

test("F6 中带落到不写入的分支时，exitedAt 仍如实记成 6", async () => {
	const store = createMemoryCacheStore();
	await harness({ store }).cache.resolve(ASK, answering("原答案"));

	// mid 且没有 refine → 退化成完整生成；noStore 让它走不写入那条返回
	const { cache } = harness({
		store,
		policy: noStore,
		passage: { "CHUNK n1": forCosine(0.85) },
		support: { high: 0.9, low: 0.8 },
	});
	const result = await cache.resolve(OPEN, answering("完整生成的"));
	assert.equal(result.outcome, "generated");
	assert.equal(result.exitedAt, 6, "被 ⑥ 放弃的中带，各分支都该记 6");
});
