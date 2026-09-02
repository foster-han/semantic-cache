/**
 * The metrics accumulator.
 *
 * A metric computed wrong is worse than no metric — someone will tune a threshold by it. So every
 * number has a test, especially the ones easily taken for granted: no NaN when requests is 0,
 * latency split by hit and miss, and a miss attributed to the gate that actually stopped it.
 */

import { createMetrics } from "../src/Metrics.ts";
import type { CacheResult, GateId, GateTrace, Outcome } from "../src/types/Pipeline.ts";
import { answering, harness } from "./Fakes.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";

function result(
	outcome: Outcome,
	exitedAt: GateId | null = null,
	trace: Array<GateTrace> = [],
	bypassReason: string | null = null,
	wouldReuse: boolean | null = null,
): CacheResult {
	return {
		payload: { kind: "answer", answer: "a" },
		outcome,
		bypassReason,
		wouldReuse,
		exitedAt,
		entryId: outcome === "generated" ? null : "e1",
		scope: "org:1|course:1",
		trace,
	};
}

const exitAt = (gate: GateId): Array<GateTrace> => [{ gate, name: "x", verdict: "exit", detail: "d" }];

/** The cases that go through the real pipeline share this one question. */
const P = { matchText: "问题", retrievalText: "问题", context: {} };

test("an empty snapshot has a hit rate of 0, not NaN — one NaN on a dashboard reads as an outage", () => {
	const s = createMetrics().snapshot();
	assert.equal(s.requests, 0);
	assert.equal(s.hitRate, 0);
	assert.equal(s.latencyMs.hit.p50, 0);
	assert.deepEqual(s.missedAtGate, {});
});

test("exact and reuse both count as hits, generated counts as a miss", () => {
	const m = createMetrics();
	m.record({ result: result("exact") });
	m.record({ result: result("reuse") });
	m.record({ result: result("generated", 3) });
	const s = m.snapshot();
	assert.equal(s.requests, 3);
	assert.equal(s.hits, 2);
	assert.equal(s.misses, 1);
	assert.equal(s.hitRate, 2 / 3);
	assert.deepEqual(s.byOutcome, { exact: 1, reuse: 1, generated: 1, bypassed: 0 });
});

test("policy bypasses form their own bucket grouped by reason — never folded into generated", () => {
	const m = createMetrics();
	m.record({ result: result("generated", 3) });
	m.record({ result: result("bypassed", null, [], "依赖对话上下文") });
	m.record({ result: result("bypassed", null, [], "依赖对话上下文") });
	m.record({ result: result("bypassed", null, [], "有副作用") });
	const s = m.snapshot();
	// A bypass is not a hit, and must not blend into the same number as a consulted miss either.
	assert.equal(s.hits, 0);
	assert.equal(s.byOutcome.generated, 1);
	assert.equal(s.byOutcome.bypassed, 3);
	// Descending by reason: a dashboard should show the highest-volume rule first.
	assert.deepEqual(s.bypassedByReason, { 依赖对话上下文: 2, 有副作用: 1 });
	// missedAtGate counts only requests that really ran a gate, and a bypass ran none.
	assert.deepEqual(s.missedAtGate, { 3: 1 });
	// The totals must not blend either: misses counts only consulted-and-missed, and the hit rate's
	// denominator is what was actually consulted.
	assert.equal(s.requests, 4);
	assert.equal(s.attempted, 1);
	assert.equal(s.misses, 1, "3 次绕开不是 3 次未命中");
	assert.equal(s.hitRate, 0);
});

test("a bypass must not dilute the hit rate — a policy bypassing most traffic would make the cache look like it hits nothing", () => {
	const m = createMetrics();
	m.record({ result: result("exact"), ms: 5 });
	for (let i = 0; i < 9; i++) {
		m.record({ result: result("bypassed", null, [], "有副作用"), ms: 500 });
	}
	const s = m.snapshot();
	// It used to report misses 9, a hitRate of 0.1 and a miss-latency p50 of 500ms — all three
	// numbers propped up by bypasses.
	assert.equal(s.misses, 0, "一次都没「查了没命中」");
	assert.equal(s.hitRate, 1, "查过的那一次命中了");
	assert.equal(s.attempted, 1);
	// requests = hits + misses + bypassed, and the three numbers reconcile.
	assert.equal(s.requests, s.hits + s.misses + s.byOutcome.bypassed);
	assert.equal(s.latencyMs.miss.count, 0);
	assert.equal(s.latencyMs.bypassed.count, 9, "绕开自成一档：它是「什么缓存都不用」的基线");
	assert.equal(s.latencyMs.bypassed.p50, 500);
});

test("the per-segment denominator is also 'actually consulted' — otherwise the two hit rates contradict each other", () => {
	const m = createMetrics();
	m.record({ result: result("reuse"), segment: "course:ml101" });
	m.record({ result: result("bypassed", null, [], "有副作用"), segment: "course:ml101" });
	m.record({ result: result("bypassed", null, [], "有副作用"), segment: "course:ml101" });
	const s = m.snapshot();
	assert.equal(s.bySegment[0].requests, 3);
	assert.equal(s.bySegment[0].bypassed, 2);
	assert.equal(s.bySegment[0].hitRate, 1, "查过的那一次命中了，不是 1/3");
});

test("misses are classified by gate — the responses differ completely, and one blended number is useless", () => {
	const m = createMetrics();
	m.record({ result: result("generated", 3) });
	m.record({ result: result("generated", 3) });
	m.record({ result: result("generated", 4) });
	m.record({ result: result("reuse") }); // A hit does not enter this distribution.
	assert.deepEqual(m.snapshot().missedAtGate, { 3: 2, 4: 1 });
});

test("latency is split by hit and miss — blended, the average is flattened by the few milliseconds a hit costs", () => {
	const m = createMetrics();
	for (const ms of [10, 12, 14]) {
		m.record({ result: result("reuse"), ms });
	}
	for (const ms of [900, 1000, 1100]) {
		m.record({ result: result("generated", 3), ms });
	}
	const s = m.snapshot();
	assert.equal(s.latencyMs.hit.count, 3);
	assert.equal(s.latencyMs.hit.p50, 12);
	assert.equal(s.latencyMs.hit.max, 14);
	assert.equal(s.latencyMs.miss.count, 3);
	assert.equal(s.latencyMs.miss.p50, 1000);
	assert.equal(s.latencyMs.miss.max, 1100);
});

test("omitting ms keeps it out of the latency statistics while still counting the request", () => {
	const m = createMetrics();
	m.record({ result: result("reuse") });
	const s = m.snapshot();
	assert.equal(s.requests, 1);
	assert.equal(s.latencyMs.hit.count, 0);
});

test("percentiles use nearest rank without interpolation — a reported latency must be one that actually occurred", () => {
	const m = createMetrics();
	for (const ms of [1, 2, 3, 4, 100]) {
		m.record({ result: result("reuse"), ms });
	}
	const hit = m.snapshot().latencyMs.hit;
	assert.equal(hit.p50, 3);
	assert.equal(hit.p95, 100);
});

test("latency samples are bounded and the ring overwrites — an unbounded array is a memory leak in a long-running process", () => {
	const m = createMetrics({ latencySamples: 4 });
	for (const ms of [1, 2, 3, 4, 5, 6]) {
		m.record({ result: result("reuse"), ms });
	}
	const hit = m.snapshot().latencyMs.hit;
	assert.equal(hit.count, 4);
	// The earliest 1 and 2 are overwritten, leaving {3,4,5,6}.
	assert.equal(hit.max, 6);
	// Four samples, nearest rank: p50 takes the 2nd after sorting, so 4 — not 4.5, since there is
	// no interpolation.
	assert.equal(hit.p50, 4);
});

test("generations saved outright = exact + reuse; with no unit price nothing is converted to money", () => {
	const m = createMetrics();
	m.record({ result: result("reuse") });
	m.record({ result: result("generated", 3) });
	assert.deepEqual(m.snapshot().saved, { generations: 1, cost: null });

	const priced = createMetrics({ costPerGeneration: 0.0075 });
	priced.record({ result: result("exact") });
	priced.record({ result: result("reuse") });
	assert.equal(priced.snapshot().saved.cost, 0.015);
});

test("segments are ordered by descending request count — a dashboard should show the busiest first", () => {
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

test("a snapshot is a copy — recording after taking one must not mutate what the caller holds", () => {
	const m = createMetrics();
	m.record({ result: result("reuse") });
	const first = m.snapshot();
	m.record({ result: result("reuse") });
	assert.equal(first.requests, 1);
	assert.equal(first.byOutcome.reuse, 1);
	assert.equal(m.snapshot().requests, 2);
});

test("reset clears everything", () => {
	const m = createMetrics({ costPerGeneration: 1 });
	m.record({ result: result("reuse"), ms: 5, segment: "s" });
	m.record({ result: result("generated", 4, exitAt(4)), ms: 500 });
	m.record({ result: result("bypassed", null, [], "有副作用"), ms: 700 });
	m.reset();
	const s = m.snapshot();
	assert.equal(s.requests, 0);
	assert.equal(s.attempted, 0);
	assert.equal(s.latencyMs.bypassed.count, 0);
	assert.equal(s.hits, 0);
	assert.equal(s.latencyMs.miss.count, 0);
	assert.equal(s.bySegment.length, 0);
	assert.equal(s.saved.cost, 0);
});

test("the shadow ledger: the would-be hit rate is independent of the real one", () => {
	const m = createMetrics();
	// In shadow mode every outcome is generated, so the hit rate is always 0.
	m.record({ result: result("generated", null, [], null, true) });
	m.record({ result: result("generated", null, [], null, true) });
	m.record({ result: result("generated", null, [], null, false) });
	// A non-shadow request has a null wouldReuse and stays out of the denominator.
	m.record({ result: result("exact") });

	const s = m.snapshot();
	assert.equal(s.hitRate, 0.25, "真实命中率只认那一次 exact");
	assert.equal(s.shadow.requests, 3);
	assert.equal(s.shadow.wouldReuse, 2);
	assert.ok(Math.abs(s.shadow.wouldReuseRate - 2 / 3) < 1e-9, "真开了大约能命中 2/3");
});

/* ---------- Fed real traces rather than hand-built ones ---------- */

/**
 * The cases above all hand-build a `GateTrace`, which tests how metrics count and how the pipeline
 * emits traces cleanly on their own and leaves the seam between them untested. There used to be a
 * pair of cases here about eviction accounting — the pipeline emitted several kinds of `exit` that
 * deleted nothing while metrics counted each as an eviction. Nothing on the read path deletes any
 * more (⑤ was the only one), so the counter is gone and so is that seam; what is left worth
 * checking through a real `resolve()` is that a cold cache attributes its miss to the right gate.
 */
test("a cold cache: the miss is attributed to ③, and the fresh entry lands in the store", async () => {
	const h = harness();
	const m = createMetrics();
	m.record({ result: await h.cache.resolve(P, answering("A1")) });
	assert.equal((await h.store.all()).length, 1);
	assert.deepEqual(m.snapshot().missedAtGate, { 3: 1 }, "空缓存下 ③ 没有候选，未命中该记在 ③");
});
