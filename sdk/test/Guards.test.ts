/**
 * 两道「构造上必然出错」的守卫：脱敏 × 共享 scope × answer，以及写入票据配错 prompt。
 * 两者都完全静默 —— 出错的表现是几天后有人拿到别人的答案，或者一条缓存永远读不回来。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { CachedPayload } from "../src/types/Pipeline.ts";
import { harness } from "./Fakes.ts";

const REDACTED = {
	matchText: "<PERSON_1> 的作业二扣了多少？",
	retrievalText: "张三的作业二扣了多少？",
	redacted: true,
	context: { userId: "s1" },
};
const answer = async (): Promise<CachedPayload> => ({ kind: "answer", answer: "扣了 10 分", sourceIds: ["n1"] });
const plan = async (): Promise<CachedPayload> => ({ kind: "plan", plan: { tool: "getGrade", assignment: "2" } });

test("脱敏 × 共享 scope × answer：直接抛错，并给出三条出路", async () => {
	const { cache } = harness({ scope: () => ({ key: "course:1", shared: true }) });
	await assert.rejects(cache.resolve(REDACTED, answer), (err: Error) => {
		assert.match(err.message, /脱敏请求命中\/写入了共享 scope/u);
		assert.match(err.message, /shared: false/u, "得告诉调用方怎么隔离");
		assert.match(err.message, /kind:"plan"/u, "也得告诉他工具类问题该走哪条");
		return true;
	});
});

test("脱敏 × 共享 scope × plan：这正是所求，不该拦", async () => {
	const { cache, store } = harness({ scope: () => ({ key: "course:1", shared: true }) });
	const first = await cache.resolve(REDACTED, plan);
	assert.equal(first.outcome, "generated");
	// 另一个学生问同一句（脱敏后字面相同）—— 塌陷在这一支是收益
	const second = await cache.resolve({ ...REDACTED, retrievalText: "李四的作业二扣了多少？", context: { userId: "s2" } }, plan);
	assert.equal(second.outcome, "exact");
	assert.equal((await store.all()).length, 1, "一条 plan 模板服务所有人");
});

test("ScopeResolver 只返回字符串时保守地当作共享 scope", async () => {
	const { cache } = harness({ scope: () => "user:s1" });
	await assert.rejects(cache.resolve(REDACTED, answer), /共享 scope/u);
});

test("守卫在命中路径上也生效 —— 声明缺失的那次写进去了，读的时候也得拦", async () => {
	let redacted = false;
	const { cache } = harness({ scope: () => ({ key: "course:1", shared: true }) });
	// 先按「没声明脱敏」写进共享 scope
	await cache.resolve({ ...REDACTED, redacted }, answer);
	redacted = true;
	await assert.rejects(cache.lookup({ ...REDACTED, redacted }), /共享 scope/u);
});

test("守卫跑在任何编码之前 —— 别先付掉一整批 embedding 再抛", async () => {
	const { cache, counts } = harness({ scope: () => ({ key: "course:1", shared: true }) });
	await assert.rejects(
		cache.writeMany([
			{ prompt: REDACTED, payload: { kind: "answer", answer: "a", sourceIds: ["n1"] } },
			{ prompt: REDACTED, payload: { kind: "answer", answer: "b", sourceIds: ["n1"] } },
		]),
		/共享 scope/u,
	);
	assert.equal(counts.questions, 0, "召回向量不该被编码");
	assert.equal(counts.passage, 0, "答案向量更不该");
});

test("写入票据配错 prompt：文本不一致要抛", async () => {
	const { cache } = harness();
	const found = await cache.lookup({ matchText: "问题 A", retrievalText: "问题 A", context: {} });
	const ticket = await found.prepareWrite();
	await assert.rejects(
		cache.write({ matchText: "问题 B", retrievalText: "问题 B", context: {} }, { kind: "answer", answer: "x", sourceIds: ["n1"] }, { ticket }),
		/不是同一个问题/u,
	);
});

test("写入票据配错 prompt：scope 不一致要抛（这比读不回来更糟，是跨边界写入）", async () => {
	const { cache } = harness({ scope: prompt => `course:${prompt.context.courseId ?? "-"}` });
	const found = await cache.lookup({ matchText: "问题 A", retrievalText: "问题 A", context: { courseId: "1" } });
	const ticket = await found.prepareWrite();
	await assert.rejects(
		cache.write(
			{ matchText: "问题 A", retrievalText: "问题 A", context: { courseId: "2" } },
			{ kind: "answer", answer: "x", sourceIds: ["n1"] },
			{ ticket },
		),
		/隔离边界不一致/u,
	);
});

test("票据是记忆化的函数，不是字段 —— 调几次只编一次向量", async () => {
	const { cache, counts } = harness();
	const found = await cache.lookup({ matchText: "问题 A", retrievalText: "问题 A", context: {} });
	const before = counts.questions;
	const a = await found.prepareWrite();
	const b = await found.prepareWrite();
	assert.deepEqual(a, b);
	assert.equal(counts.questions, before, "③ 已经编过一次，票据不该再编");
});
