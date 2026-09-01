/**
 * 指标累加器。
 *
 * 算错的指标比没有指标更糟 —— 它会让人据此调阈值。所以每个数都有一条测试，
 * 尤其是那几个容易想当然的：requests=0 时不能是 NaN、延迟要按命中/未命中分开、
 * 驱逐要能说出是 ⑤ 还是 ⑥ 判的。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMetrics } from "../src/Metrics.ts";
import { answering, BASE, forCosine, harness } from "./Fakes.ts";
import type { CacheResult, GateId, GateTrace, Outcome } from "../src/types/Pipeline.ts";

function result(
	outcome: Outcome,
	exitedAt: GateId | null = null,
	trace: Array<GateTrace> = [],
	bypassReason: string | null = null,
	wouldReuse: boolean | null = null,
): CacheResult {
	return {
		payload: { kind: "answer", answer: "a", sourceIds: ["n1"] },
		outcome,
		bypassReason,
		wouldReuse,
		exitedAt,
		entryId: outcome === "generated" ? null : "e1",
		sourceIds: ["n1"],
		trace,
	};
}

/** 真驱逐：exit **且**删了条目 */
const exitAt = (gate: GateId): Array<GateTrace> => [{ gate, name: "x", verdict: "exit", detail: "d", evicted: true }];
/** 判负但什么都没删 —— ⑥ 的「判不了」、答案无依据不写入、影子模式都是这一种 */
/** 走真管线的用例共用这一个问题 */
const P = { matchText: "问题", retrievalText: "问题", context: {} };

const exitNoEvict = (gate: GateId): Array<GateTrace> => [{ gate, name: "x", verdict: "exit", detail: "d" }];

test("空的时候命中率是 0，不是 NaN —— 看板上一个 NaN 就会让人以为服务挂了", () => {
	const s = createMetrics().snapshot();
	assert.equal(s.requests, 0);
	assert.equal(s.hitRate, 0);
	assert.equal(s.latencyMs.hit.p50, 0);
	assert.deepEqual(s.missedAtGate, {});
});

test("exact / reuse / refine 都算命中，generated 算未命中", () => {
	const m = createMetrics();
	m.record({ result: result("exact") });
	m.record({ result: result("reuse") });
	m.record({ result: result("refine") });
	m.record({ result: result("generated", 3) });
	const s = m.snapshot();
	assert.equal(s.requests, 4);
	assert.equal(s.hits, 3);
	assert.equal(s.misses, 1);
	assert.equal(s.hitRate, 0.75);
	assert.deepEqual(s.byOutcome, { exact: 1, reuse: 1, refine: 1, generated: 1, bypassed: 0 });
});

test("策略绕开单独成一档，并按理由分组 —— 不能混进 generated", () => {
	const m = createMetrics();
	m.record({ result: result("generated", 3) });
	m.record({ result: result("bypassed", null, [], "依赖对话上下文") });
	m.record({ result: result("bypassed", null, [], "依赖对话上下文") });
	m.record({ result: result("bypassed", null, [], "有副作用") });
	const s = m.snapshot();
	// 绕开不是命中，但也不该和「查了没命中」混成一个数
	assert.equal(s.hits, 0);
	assert.equal(s.byOutcome.generated, 1);
	assert.equal(s.byOutcome.bypassed, 3);
	// 按理由降序 —— 看板要先看量最大的那条规则
	assert.deepEqual(s.bypassedByReason, { 依赖对话上下文: 2, 有副作用: 1 });
	// missedAtGate 只认真正跑过闸的：绕开一道闸都没跑
	assert.deepEqual(s.missedAtGate, { 3: 1 });
	// 总数上也不能混：misses 只数「查了但没命中」，命中率的分母是「真的查了的」
	assert.equal(s.requests, 4);
	assert.equal(s.attempted, 1);
	assert.equal(s.misses, 1, "3 次绕开不是 3 次未命中");
	assert.equal(s.hitRate, 0);
});

test("绕开不许稀释命中率 —— 一个绕开大半流量的策略会让缓存看起来什么都命中不了", () => {
	const m = createMetrics();
	m.record({ result: result("exact"), ms: 5 });
	for (let i = 0; i < 9; i++) m.record({ result: result("bypassed", null, [], "有副作用"), ms: 500 });
	const s = m.snapshot();
	// 先前：misses 9、hitRate 0.1、未命中延迟 p50 500ms —— 三个数全是绕开撑出来的
	assert.equal(s.misses, 0, "一次都没「查了没命中」");
	assert.equal(s.hitRate, 1, "查过的那一次命中了");
	assert.equal(s.attempted, 1);
	// requests = hits + misses + bypassed，三个数对得上
	assert.equal(s.requests, s.hits + s.misses + s.byOutcome.bypassed);
	assert.equal(s.latencyMs.miss.count, 0);
	assert.equal(s.latencyMs.bypassed.count, 9, "绕开自成一档：它是「什么缓存都不用」的基线");
	assert.equal(s.latencyMs.bypassed.p50, 500);
});

test("分段命中率的分母同样是「真的查了的」—— 否则两个命中率会打架", () => {
	const m = createMetrics();
	m.record({ result: result("reuse"), segment: "course:ml101" });
	m.record({ result: result("bypassed", null, [], "有副作用"), segment: "course:ml101" });
	m.record({ result: result("bypassed", null, [], "有副作用"), segment: "course:ml101" });
	const s = m.snapshot();
	assert.equal(s.bySegment[0].requests, 3);
	assert.equal(s.bySegment[0].bypassed, 2);
	assert.equal(s.bySegment[0].hitRate, 1, "查过的那一次命中了，不是 1/3");
});

test("未命中按闸分类 —— 三种未命中的处置完全不同，混成一个数就没用了", () => {
	const m = createMetrics();
	m.record({ result: result("generated", 3) });
	m.record({ result: result("generated", 3) });
	m.record({ result: result("generated", 6) });
	m.record({ result: result("reuse") }); // 命中不进这个分布
	assert.deepEqual(m.snapshot().missedAtGate, { 3: 2, 6: 1 });
});

test("驱逐能说出是 ⑤ 还是 ⑥ 判的", () => {
	const m = createMetrics();
	m.record({ result: result("generated", 5, exitAt(5)) });
	m.record({ result: result("generated", 6, exitAt(6)) });
	m.record({ result: result("generated", 6, exitAt(6)) });
	assert.deepEqual(m.snapshot().evictions, { total: 3, bySourceVersion: 1, byAnswerCheck: 2 });
});

test("③④ 的 exit 不算驱逐 —— 那时根本没有条目被删", () => {
	const m = createMetrics();
	m.record({ result: result("generated", 3, exitAt(3)) });
	m.record({ result: result("generated", 4, exitAt(4)) });
	assert.equal(m.snapshot().evictions.total, 0);
});

test("⑥ 的 exit 里没删条目的那些也不算驱逐 —— 认 evicted，不反推 verdict", () => {
	const m = createMetrics();
	// ⑥ 发 exit 但什么都没删的分支：检索空/答案向量空「判不了」、答案无资料依据
	// 不写入、中带微调失败、影子模式判负。反推 verdict 的话它们全被算成驱逐 ——
	// retriever 一次故障就能让看板报出满屏「⑥ 判负驱逐」，而缓存一条没动。
	m.record({ result: result("generated", 6, exitNoEvict(6)) });
	m.record({ result: result("generated", 6, exitNoEvict(6)) });
	m.record({ result: result("generated", 5, exitNoEvict(5)) });
	assert.deepEqual(m.snapshot().evictions, { total: 0, bySourceVersion: 0, byAnswerCheck: 0 });
	// 但它们照样算「未命中，被 ⑥ 拦下」—— 那件事确实发生了
	assert.deepEqual(m.snapshot().missedAtGate, { 5: 1, 6: 2 });
});

test("延迟按命中/未命中分开 —— 混在一起均值会被命中的几毫秒拉平", () => {
	const m = createMetrics();
	for (const ms of [10, 12, 14]) m.record({ result: result("reuse"), ms });
	for (const ms of [900, 1000, 1100]) m.record({ result: result("generated", 3), ms });
	const s = m.snapshot();
	assert.equal(s.latencyMs.hit.count, 3);
	assert.equal(s.latencyMs.hit.p50, 12);
	assert.equal(s.latencyMs.hit.max, 14);
	assert.equal(s.latencyMs.miss.count, 3);
	assert.equal(s.latencyMs.miss.p50, 1000);
	assert.equal(s.latencyMs.miss.max, 1100);
});

test("不给 ms 就不进延迟统计，但仍然计入请求数", () => {
	const m = createMetrics();
	m.record({ result: result("reuse") });
	const s = m.snapshot();
	assert.equal(s.requests, 1);
	assert.equal(s.latencyMs.hit.count, 0);
});

test("分位数用最近秩，不插值 —— 报出来的必须是真实出现过的延迟", () => {
	const m = createMetrics();
	for (const ms of [1, 2, 3, 4, 100]) m.record({ result: result("reuse"), ms });
	const hit = m.snapshot().latencyMs.hit;
	assert.equal(hit.p50, 3);
	assert.equal(hit.p95, 100);
});

test("延迟样本有上限，超了环形覆盖 —— 长跑进程里无上限数组就是内存泄漏", () => {
	const m = createMetrics({ latencySamples: 4 });
	for (const ms of [1, 2, 3, 4, 5, 6]) m.record({ result: result("reuse"), ms });
	const hit = m.snapshot().latencyMs.hit;
	assert.equal(hit.count, 4);
	// 覆盖掉最早的 1、2，留下 {3,4,5,6}
	assert.equal(hit.max, 6);
	// 4 个样本、最近秩法：p50 取排序后第 2 个 = 4（不插值，所以不是 4.5）
	assert.equal(hit.p50, 4);
});

test("完整省下的生成次数 = exact + reuse；没给单价就不折算成钱", () => {
	const m = createMetrics();
	m.record({ result: result("reuse") });
	m.record({ result: result("generated", 3) });
	assert.deepEqual(m.snapshot().saved, { generations: 1, cost: null });

	const priced = createMetrics({ costPerGeneration: 0.0075 });
	priced.record({ result: result("exact") });
	priced.record({ result: result("reuse") });
	assert.equal(priced.snapshot().saved.cost, 0.015);
});

test("refine 算命中，但不算「完整省下一次生成」—— 它确实跑了一次短生成", () => {
	const m = createMetrics({ costPerGeneration: 1 });
	m.record({ result: result("refine") });
	const s = m.snapshot();
	assert.equal(s.hits, 1, "refine 复用了旧答案，是命中");
	assert.equal(s.byOutcome.refine, 1);
	// 记成整次省下就是把节省报高。想按短生成的单价折算，用 byOutcome.refine 自己乘
	assert.deepEqual(s.saved, { generations: 0, cost: 0 });
});

test("分段命中率按请求数降序 —— 看板要先看流量大的那一段", () => {
	const m = createMetrics();
	m.record({ result: result("reuse"), segment: "course:ml101" });
	m.record({ result: result("generated", 3), segment: "course:ml101" });
	m.record({ result: result("generated", 3), segment: "course:ml101" });
	m.record({ result: result("reuse"), segment: "course:db300" });
	const s = m.snapshot();
	assert.equal(s.bySegment.length, 2);
	assert.equal(s.bySegment[0].segment, "course:ml101");
	assert.equal(s.bySegment[0].requests, 3);
	assert.equal(Math.round(s.bySegment[0].hitRate * 100), 33);
	assert.equal(s.bySegment[1].hitRate, 1);
});

test("snapshot 是拷贝 —— 拿到之后再 record 不该改动手里那份", () => {
	const m = createMetrics();
	m.record({ result: result("reuse") });
	const first = m.snapshot();
	m.record({ result: result("reuse") });
	assert.equal(first.requests, 1);
	assert.equal(first.byOutcome.reuse, 1);
	assert.equal(m.snapshot().requests, 2);
});

test("reset 清空一切", () => {
	const m = createMetrics({ costPerGeneration: 1 });
	m.record({ result: result("reuse"), ms: 5, segment: "s" });
	m.record({ result: result("generated", 6, exitAt(6)), ms: 500 });
	m.record({ result: result("bypassed", null, [], "有副作用"), ms: 700 });
	m.reset();
	const s = m.snapshot();
	assert.equal(s.requests, 0);
	assert.equal(s.attempted, 0);
	assert.equal(s.latencyMs.bypassed.count, 0);
	assert.equal(s.hits, 0);
	assert.equal(s.evictions.total, 0);
	assert.equal(s.latencyMs.miss.count, 0);
	assert.equal(s.bySegment.length, 0);
	assert.equal(s.saved.cost, 0);
});

test("支撑度分布：从 ⑥ 的 trace 里取，命中与驱逐分开", () => {
	const m = createMetrics({ supportThresholds: { high: 0.967, low: 0.936 } });
	const six = (score: number, verdict: "pass" | "exit"): Array<GateTrace> => [
		{ gate: 6, name: "回答有效性校验", verdict, detail: "", score },
	];
	// 三次命中：一次很稳、一次落在微调带、一次擦着线过
	m.record({ result: result("reuse", null, six(0.999, "pass")) });
	m.record({ result: result("reuse", null, six(0.9500, "pass")) });
	m.record({ result: result("reuse", null, six(0.9675, "pass")) });
	// 两次被 ⑥ 驱逐
	m.record({ result: result("generated", 6, six(0.9102, "exit")) });
	m.record({ result: result("generated", 6, six(0.8801, "exit")) });

	const s = m.snapshot();
	assert.equal(s.support.onHit.count, 3);
	assert.equal(s.support.onHit.min, 0.95);
	assert.equal(s.support.onEvict.count, 2);
	assert.equal(s.support.onEvict.max, 0.9102);
	// 余量 = 最险的 10% 离 θa高 还有多远。这里 p10 就是最小值 0.95
	assert.ok(Math.abs((s.support.headroomP10 ?? 0) - (0.95 - 0.967)) < 1e-9);
	// 0.95 落在 [0.936, 0.967) 里 —— 三次命中中的一次
	assert.ok(Math.abs((s.support.midBandRate ?? 0) - 1 / 3) < 1e-9);
});

test("没给阈值就给不出余量和微调带比例 —— 不猜一个默认阈值", () => {
	const m = createMetrics();
	m.record({ result: result("reuse", null, [{ gate: 6, name: "回答有效性校验", verdict: "pass", detail: "", score: 0.99 }]) });
	const s = m.snapshot();
	assert.equal(s.support.onHit.count, 1, "分布本身不需要阈值");
	assert.equal(s.support.headroomP10, null);
	assert.equal(s.support.midBandRate, null);
});

test("⑥ 的「写入」「中带处理」条目不带 score，不能被当成支撑度样本", () => {
	const m = createMetrics();
	m.record({
		result: result("generated", null, [
			{ gate: 6, name: "中带处理", verdict: "exit", detail: "未提供 refine" },
			{ gate: 6, name: "写入", verdict: "off", detail: "策略判定不写入" },
		]),
	});
	const s = m.snapshot();
	assert.equal(s.support.onHit.count, 0);
	assert.equal(s.support.onEvict.count, 0);
});

test("影子模式的账：本会命中率独立于真实命中率", () => {
	const m = createMetrics();
	// 影子模式下 outcome 全是 generated，命中率恒为 0
	m.record({ result: result("generated", null, [], null, true) });
	m.record({ result: result("generated", null, [], null, true) });
	m.record({ result: result("generated", null, [], null, false) });
	// 非影子的请求 wouldReuse 为 null，不进分母
	m.record({ result: result("exact") });

	const s = m.snapshot();
	assert.equal(s.hitRate, 0.25, "真实命中率只认那一次 exact");
	assert.equal(s.shadow.requests, 3);
	assert.equal(s.shadow.wouldReuse, 2);
	assert.ok(Math.abs(s.shadow.wouldReuseRate - 2 / 3) < 1e-9, "真开了大约能命中 2/3");
});

/* ---------- 喂真 trace，不是手搓的 ---------- */

/**
 * 上面那些用例都手搓 `GateTrace`，于是「指标怎么数」和「管线怎么发 trace」这两件事
 * 各自测得很干净，中间那条缝没人测 —— 而 bug 恰好长在缝里：管线在 ⑥ 上发过四种
 * 什么都没删的 `exit`，指标却按 gate 号把它们全算成驱逐。所以下面这几条一律走真
 * `resolve()`，断言的是「存储里少了几条」和「指标说少了几条」对得上。
 */
test("retriever 一次故障不许在看板上变成驱逐", async () => {
	let broken = false;
	const h = harness({ retrieve: () => (broken ? [] : [{ id: "n1", text: "CHUNK n1" }]) });
	await h.cache.resolve(P, answering("A1"));
	broken = true;

	const m = createMetrics();
	m.record({ result: await h.cache.resolve(P, answering("A2")) });
	assert.equal((await h.store.all()).length, 1, "条目必须留着 —— 缺证据不是有罪");
	assert.deepEqual(m.snapshot().evictions, { total: 0, bySourceVersion: 0, byAnswerCheck: 0 });
	// 「查了但没用上，是 ⑥ 拦的」照样要报 —— 不复用这件事确实发生了
	assert.deepEqual(m.snapshot().missedAtGate, { 6: 1 });
});

test("冷缓存 + 无资料依据的答案：一条候选都没有，也不许报驱逐", async () => {
	const h = harness();
	const m = createMetrics();
	m.record({
		result: await h.cache.resolve(P, async () => ({ kind: "answer" as const, answer: "无依据", sourceIds: [] })),
	});
	assert.equal((await h.store.all()).length, 0, "什么都没写进去");
	assert.deepEqual(m.snapshot().evictions, { total: 0, bySourceVersion: 0, byAnswerCheck: 0 });
});

test("⑤ 判负的真驱逐照样要数上", async () => {
	let version = "v1";
	const h = harness({ sourceVersion: () => version });
	await h.cache.resolve(P, answering("A1"));
	version = "v2";
	const m = createMetrics();
	m.record({ result: await h.cache.resolve(P, answering("A2")) });
	assert.deepEqual(m.snapshot().evictions, { total: 1, bySourceVersion: 1, byAnswerCheck: 0 });
});

test("⑥ 判负的真驱逐照样要数上", async () => {
	const h = harness({ passage: { A: forCosine(0.2), "CHUNK n1": [...BASE] }, support: { high: 0.9, low: 0.8 } });
	await h.cache.write(P, { kind: "answer", answer: "A", sourceIds: ["n1"] });
	const m = createMetrics();
	m.record({ result: await h.cache.resolve(P, answering("A2")) });
	assert.deepEqual(m.snapshot().evictions, { total: 1, bySourceVersion: 0, byAnswerCheck: 1 });
});

test("影子模式：⑥ 判负但不删 —— 驱逐数是 0，支撑度分布照样收样本", async () => {
	// 判定与动作刻意不同源：影子模式的全部意义就是「量出上线后 ⑥ 会拦掉什么」，
	// 所以那次判定必须进 support.onEvict；但它一条都没删，所以 evictions 必须是 0。
	const h = harness({
		shadow: true,
		passage: { A: forCosine(0.2), "CHUNK n1": [...BASE] },
		support: { high: 0.9, low: 0.8 },
	});
	await h.cache.write(P, { kind: "answer", answer: "A", sourceIds: ["n1"] });
	const m = createMetrics();
	m.record({ result: await h.cache.resolve(P, answering("A2")) });
	const s = m.snapshot();
	assert.equal((await h.store.all()).length, 1, "影子模式一条都不删");
	assert.deepEqual(s.evictions, { total: 0, bySourceVersion: 0, byAnswerCheck: 0 });
	assert.equal(s.support.onEvict.count, 1, "判负那次的支撑度要留下");
});

test("影子模式：「本会命中」的支撑度要进 onHit —— 否则影子模式量不出「那些命中有多险」", async () => {
	/**
	 * 影子模式下 `outcome` 恒为 `generated`，按 outcome 认命中的话这一栏是空的，
	 * 于是 `headroomP10` / `midBandRate` 全是空 —— 而影子模式的用处恰恰是上线前
	 * 先看一眼那些命中离阈值多近。⑥ 判出来的那个分数，本会命中和真命中在分布上
	 * 是同一个点；出口侧（onEvict）先前就是这么认的，入口侧漏了。
	 */
	const h = harness({ shadow: true, passage: { A: forCosine(0.95), "CHUNK n1": [...BASE] }, support: { high: 0.9, low: 0.8 } });
	await h.cache.write(P, { kind: "answer", answer: "A", sourceIds: ["n1"] });
	const m = createMetrics({ supportThresholds: { high: 0.9, low: 0.8 } });
	const result = await h.cache.resolve(P, answering("影子里新生成的"));
	m.record({ result });
	const s = m.snapshot();

	assert.equal(result.outcome, "generated", "影子模式永远不复用");
	assert.equal(result.wouldReuse, true);
	assert.equal(s.support.onHit.count, 1, "本会命中的那次支撑度必须留下");
	assert.notEqual(s.support.headroomP10, null, "有样本就该算得出余量");
	assert.ok(Math.abs((s.support.headroomP10 ?? 0) - (0.95 - 0.9)) < 1e-6);
	assert.equal(s.support.midBandRate, 0, "0.95 在高档之上，不在微调带里");
	// 但它不许进真实命中的那几个数：实际发生的是一次生成
	assert.equal(s.hits, 0);
	assert.equal(s.hitRate, 0);
	assert.equal(s.shadow.wouldReuseRate, 1, "「本会命中多少」在这里，不在 hitRate 里");
});
