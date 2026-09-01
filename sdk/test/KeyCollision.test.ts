/**
 * 分隔符出现在数据里 —— 同一类 bug 的三个现场。
 *
 * `Scope.ts` 已经用转义防住了分桶那一处；这里锁住剩下两处，以及「加了新 Outcome
 * 之后否定判据会误分类」那一类。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createStructuralPolicy } from "../src/CachePolicyRules.ts";
import { createMetrics } from "../src/Metrics.ts";
import type { CacheResult, Outcome } from "../src/types/Pipeline.ts";
import { answering, harness } from "./Fakes.ts";

/* ---------- N2：合流键 ---------- */

test("N2 context 里带 & 或 = 的两个不同请求不能合流", async () => {
	const counts = { n: 0 };
	const generate = async () => {
		counts.n += 1;
		return { kind: "answer" as const, answer: `第 ${counts.n} 次生成`, sourceIds: ["n1"] };
	};
	// 旧实现把 context 拼成 `k=v&k=v`，这两个会得到同一个键
	const a = { matchText: "同一句话", retrievalText: "同一句话", context: { a: "b&c=d" } };
	const b = { matchText: "同一句话", retrievalText: "同一句话", context: { a: "b", c: "d" } };

	const { cache } = harness({ scope: () => ({ key: "s", shared: true, org: "o" }) });
	const [ra, rb] = await Promise.all([cache.resolve(a, generate), cache.resolve(b, generate)]);

	assert.notEqual(
		ra.payload.kind === "answer" && ra.payload.answer,
		rb.payload.kind === "answer" && rb.payload.answer,
		"合流的话后到者会拿到前一个请求的答案 —— 这是错答案，不是效率问题",
	);
	assert.equal(counts.n, 2);
});

test("N2 真正相同的请求仍然合流 —— 修分隔符不能把 singleFlight 修没了", async () => {
	let calls = 0;
	const generate = async () => {
		calls += 1;
		await new Promise(r => setTimeout(r, 5));
		return { kind: "answer" as const, answer: "同一个答案", sourceIds: ["n1"] };
	};
	const prompt = { matchText: "同一句话", retrievalText: "同一句话", context: { a: "b", c: "d" } };
	const { cache } = harness();
	await Promise.all([cache.resolve(prompt, generate), cache.resolve(prompt, generate)]);
	assert.equal(calls, 1);
});

/* ---------- N3：Outcome 扩展后的分类 ---------- */

test("N3 bypassed 不是假命中 —— 它压根没查缓存", async () => {
	// 直接构造 CacheResult 走 Metrics 的正向判据，和 Evaluation 用的是同一套定义
	const m = createMetrics();
	const r = (outcome: Outcome): CacheResult => ({
		payload: { kind: "answer", answer: "a", sourceIds: ["n1"] },
		outcome,
		bypassReason: outcome === "bypassed" ? "依赖对话上下文" : null,
		wouldReuse: null,
		exitedAt: null,
		entryId: null,
		sourceIds: ["n1"],
		trace: [],
	});
	m.record({ result: r("bypassed") });
	m.record({ result: r("generated") });
	const s = m.snapshot();
	assert.equal(s.hits, 0, "两者都不是命中");
	assert.equal(s.byOutcome.bypassed, 1, "但要能和 generated 分开");
	assert.equal(s.byOutcome.generated, 1);
});

/* ---------- N4：两个 Map 有上限 ---------- */

test("N4 绕开理由的基数有上限 —— 理由里内嵌了 context 来的调用类型", async () => {
	const policy = createStructuralPolicy();
	const { cache } = harness({ policy });
	// 每次一个不同的调用类型 → 每次一条不同的理由
	for (let i = 0; i < 40; i++) {
		await cache.lookup({ matchText: "q", retrievalText: "q", context: { callType: `bogus_${i}` } });
	}
	// 直接验 Metrics 侧的上限
	const m = createMetrics({ maxDistinctKeys: 8 });
	for (let i = 0; i < 40; i++) {
		m.record({
			result: {
				payload: { kind: "answer", answer: "a", sourceIds: [] },
				outcome: "bypassed",
				bypassReason: `理由 ${i}`,
				wouldReuse: null,
				exitedAt: null,
				entryId: null,
				sourceIds: [],
				trace: [],
			},
		});
	}
	const s = m.snapshot();
	// 8 个真实键 + 一个「其它」桶
	assert.ok(Object.keys(s.bypassedByReason).length <= 9, "键数必须封顶，否则长跑进程会一直涨");
	assert.equal(s.byOutcome.bypassed, 40, "但计数一条都不能丢");
	assert.ok("（其它）" in s.bypassedByReason, "溢出的归入「其它」");
});

test("N4 分段键同样封顶，且已有的段照常累加", () => {
	const m = createMetrics({ maxDistinctKeys: 3 });
	const r: CacheResult = {
		payload: { kind: "answer", answer: "a", sourceIds: [] },
		outcome: "exact",
		bypassReason: null,
		wouldReuse: null,
		exitedAt: null,
		entryId: "e",
		sourceIds: [],
		trace: [],
	};
	for (const seg of ["a", "b", "c", "d", "e"]) m.record({ result: r, segment: seg });
	m.record({ result: r, segment: "a" });
	const s = m.snapshot();
	assert.ok(s.bySegment.length <= 4, "3 个真实段 + 一个「其它」桶");
	assert.equal(
		s.bySegment.reduce((n, x) => n + x.requests, 0),
		6,
		"封顶不能丢请求数",
	);
	assert.equal(s.bySegment.find(x => x.segment === "a")?.requests, 2, "已在表里的段照常累加");
});
