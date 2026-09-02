/**
 * 构造期的守卫。
 *
 * 这些断言全是「静默失效」的反面：越界的阈值不会报错，只会让那道闸永远放行或永远
 * 拦下；`recallLimit = 1` 不会报错，只会让 ④ 精排无候选可排；空的 `calibratedOn`
 * 不会报错，只会让半年后没人知道这组数是在什么数据上标的。所以它们必须在构造期抛。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMemoryCacheStore } from "../src/MemoryCacheStore.ts";
import { createSemanticCache } from "../src/SemanticCache.ts";
import { assertFiniteVector, cosine, hashKey, normalizeKey } from "../src/VectorMath.ts";
import type { RecallStage, RerankStage } from "../src/types/Calibration.ts";
import type { RerankTarget } from "../src/types/Encoders.ts";
import { harness } from "./Fakes.ts";

test("recallLimit 必须是大于 1 的整数 —— 非整数在真库上才炸，本地跑得通", () => {
	assert.throws(() => harness({ recallLimit: 1 }), /recallLimit 必须是大于 1 的整数/u);
	// 2.5 先前构造得出来：内存后端 slice(2.5) 照样跑，pgvector 的 LIMIT 与 Redis 的
	// VSIM COUNT 会在运行期报「不是整数」—— 一个只在上真库时才现形的配置错
	assert.throws(() => harness({ recallLimit: 2.5 }), /recallLimit 必须是大于 1 的整数/u);
	assert.throws(() => harness({ recallLimit: Number.NaN }), /recallLimit 必须是大于 1 的整数/u);
	assert.doesNotThrow(() => harness({ recallLimit: 2 }));
});

test("余弦尺度的阈值越界要当场抛，别留给运行期变成恒放行/恒拦下", () => {
	assert.throws(() => harness({ recallFloor: 1.5 }), /recall\.thresholds\.floor/u);
	assert.throws(() => harness({ recallFloor: Number.NaN }), /recall\.thresholds\.floor/u);
});

test("④ 的闸值只查有限数，不查 [-1,1] —— 重排器的尺度不是余弦", () => {
	assert.throws(() => harness({ rerank: {}, rerankFloor: Number.POSITIVE_INFINITY }), /rerank\.thresholds\.floor/u);
	// 重排器可能给 logit，5.2 是合法闸值；套 [-1,1] 才是又一次尺度混用
	assert.doesNotThrow(() => harness({ rerank: {}, rerankFloor: 5.2 }));
});

test("④ 的 target 必须是 question 或 answer —— 拼错了会静默落到另一个尺度", () => {
	/**
	 * 类型上它是联合类型，但 JS 调用方绕得过去。一个拼错的 target 若被当成
	 * 「不是 answer 就是 question」，就等于拿问↔答标定的 θq 去卡问↔问的分数 ——
	 * 同一个 bge-reranker-base 上那是 0.3494 与 0.1228 的差别，而且不报错。
	 */
	const bad = "Answer" as unknown as RerankTarget;
	assert.throws(() => harness({ rerank: {}, rerankTarget: bad }), /rerank\.thresholds\.target/u);
	assert.doesNotThrow(() => harness({ rerank: {}, rerankTarget: "answer" }));
	assert.doesNotThrow(() => harness({ rerank: {}, rerankTarget: "question" }));
});

test("calibratedOn 是必填且不能是空串 —— 阈值离开标定语境就没有意义", () => {
	assert.doesNotThrow(() => buildWith({}), "两个 stage 都给了 calibratedOn 就该通过");
	assert.throws(() => buildWith({ recall: "" }), /recall\.calibratedOn 不能是空串/u);
	assert.throws(() => buildWith({ rerank: "" }), /rerank\.calibratedOn 不能是空串/u);
});

/** 只有上面那个测试需要绕过 harness 的默认 calibratedOn，所以两个 stage 在这里现拼 */
function buildWith(blank: { recall?: string; rerank?: string }): void {
	const recall: RecallStage = {
		scorer: { async embedQuestions(texts) { return texts.map(() => [1, 0, 0]); } },
		thresholds: { floor: 0.5 },
		calibratedOn: blank.recall ?? "本次标定语境",
	};
	const rerank: RerankStage = {
		scorer: { async score() { return 1; } },
		thresholds: { floor: 0.5, target: "question" },
		calibratedOn: blank.rerank ?? "本次标定语境",
	};
	createSemanticCache({
		recall,
		rerank,
		store: createMemoryCacheStore(),
		retriever: { async retrieve() { return []; } },
		scope: () => ({ key: "course:1", shared: true, org: "org:1" }),
		sourceVersion: () => "v1",
	});
}

test("cosine 的维度检查 —— 混用两个模型角色的输出必须炸，不能给个没意义的数", () => {
	assert.throws(() => cosine([1, 0], [1, 0, 0]), /向量维度不一致/u);
	assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1);
	assert.equal(cosine([1, 0, 0], [0, 1, 0]), 0);
	// 零向量没有方向，约定为 0 —— pgvector 那边的 NaN 也归到这个值
	assert.equal(cosine([0, 0, 0], [1, 0, 0]), 0);
});

test("非有限分量三个后端一律抛 —— 一个坏编码器不能在内存后端上变成假命中", async () => {
	assert.throws(() => assertFiniteVector("matchVector ", [1, Number.NaN, 0]), /matchVector 第 1 维是 NaN/u);
	assert.throws(() => assertFiniteVector("查询向量", [Number.POSITIVE_INFINITY]), /不是有限数/u);
	assert.doesNotThrow(() => assertFiniteVector("空向量", []));

	/**
	 * 内存后端先前原样存下 NaN：`cosine` 于是返回 NaN，而 ③ 的 `similarity < floor`
	 * 对 NaN 恒为 false —— 召回下限形同不存在，一个毫不相干的问题也拿得到复用。
	 * 同一个输入在 pgvector 上是硬错、在 Redis 上被静默写成 0：三种症状。
	 */
	const store = createMemoryCacheStore();
	const entry = {
		id: "e1", scope: "s", matchText: "q", matchHash: "h", matchVector: [Number.NaN, 0, 0],
		kind: "answer" as const, answer: "a", plan: {}, 
		sourceIds: [], sourceVersion: "", createdAt: 1, expiresAt: null,
	};
	await assert.rejects(() => store.put(entry), /matchVector 第 0 维是 NaN/u);
	await assert.rejects(() => store.searchNearest("s", [Number.NaN, 0, 0], 5), /查询向量第 0 维/u);
});

test("normalizeKey 折叠空白、统一大小写、去句末标点；hashKey 稳定", () => {
	assert.equal(normalizeKey("  什么是过拟合？ "), "什么是过拟合");
	assert.equal(normalizeKey("What Is Overfitting?"), "what is overfitting");
	assert.equal(normalizeKey("同一句话！！"), "同一句话");
	assert.equal(normalizeKey("句中。的标点不动"), "句中。的标点不动");
	// 多个空白折叠成一个，不是删掉
	assert.equal(normalizeKey("what   is\tover fitting"), "what is over fitting");
	assert.equal(hashKey("abc"), hashKey("abc"));
	assert.notEqual(hashKey("abd"), hashKey("abc"));
});

test("空白折叠而非删除：英文里两个不同的问题不能归成同一个 key", () => {
	// 全删空白时这两句会撞成 "whatisoverfitting" —— ② 的「零假命中」就没了，
	// 而且 ③ 的碰撞复核用的是同一个 normalizeKey，挡不住这类合并
	assert.notEqual(normalizeKey("what is over fitting"), normalizeKey("what is overfitting"));
	assert.notEqual(hashKey(normalizeKey("a nice cache")), hashKey(normalizeKey("anice cache")));
});
