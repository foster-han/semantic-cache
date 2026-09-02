/**
 * A separator appearing in the data — three sites of one class of bug.
 *
 * `Scope.ts` already defends the bucketing site with escaping; this pins down the remaining two,
 * plus the class where a negated criterion misclassifies once a new Outcome is added.
 */

import { createStructuralPolicy } from "../src/CachePolicyRules.ts";
import { createMetrics } from "../src/Metrics.ts";
import type { CacheResult, Outcome } from "../src/types/Pipeline.ts";
import { harness } from "./Fakes.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";

/* ---------- N2: the merge key ---------- */

test("N2 two different requests whose context contains & or = must not merge", async () => {
	const counts = { n: 0 };
	const generate = () => {
		counts.n += 1;
		return Promise.resolve({ kind: "answer" as const, answer: `第 ${counts.n} 次生成` });
	};
	// The old implementation joined context as `k=v&k=v`, which gives these two the same key.
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

test("N2 genuinely identical requests still merge — fixing the separator must not break singleFlight", async () => {
	let calls = 0;
	const generate = async () => {
		calls += 1;
		await new Promise(r => setTimeout(r, 5));
		return { kind: "answer" as const, answer: "同一个答案" };
	};
	const prompt = { matchText: "同一句话", retrievalText: "同一句话", context: { a: "b", c: "d" } };
	const { cache } = harness();
	await Promise.all([cache.resolve(prompt, generate), cache.resolve(prompt, generate)]);
	assert.equal(calls, 1);
});

test("N2 the resolved scope must be in the merge key — an impure resolver merges two tenants", async () => {
	/**
	 * `ScopeResolver`'s contract is that it is a pure function of the prompt, but that is a contract
	 * and not a check — and this library applies the same rule to ③'s store-layer pre-filter,
	 * rechecking the scope once the rows come back. A resolver that reads the tenant from ambient
	 * state outside the request (AsyncLocalStorage, a header) merges the same sentence from two
	 * tenants, and the later tenant receives the answer from the earlier one's cache. On the write
	 * path a ticket's scope comparison stops this; on a read hit, nothing used to.
	 */
	let tenant = "A";
	let calls = 0;
	const generate = async () => {
		calls += 1;
		// Take the sequence number before the await: both generations are waiting out these 5ms, and
		// reading calls afterwards would give 2 to each.
		const nth = calls;
		await new Promise(r => setTimeout(r, 5));
		return { kind: "answer" as const, answer: `第 ${nth} 次生成` };
	};
	const { cache } = harness({ scope: () => ({ key: "course:1", shared: true, org: `org:${tenant}` }) });
	const prompt = { matchText: "同一句话", retrievalText: "同一句话", context: {} };

	// Concurrency: A's request arrives first, while the ambient tenant is A, then the second
	// arrives after the switch to B.
	const first = cache.resolve(prompt, generate);
	tenant = "B";
	const second = cache.resolve(prompt, generate);
	const [a, b] = await Promise.all([first, second]);

	// With the scope absent from the key these two merge: one generation, and the later request
	// receives the earlier tenant's result.
	assert.equal(calls, 2, "两个租户的请求不能共用一次生成");
	assert.notEqual(
		a.payload.kind === "answer" && a.payload.answer,
		b.payload.kind === "answer" && b.payload.answer,
		"合流的话两边会是同一个答案对象",
	);
});

/* ---------- N3: classification once Outcome is extended ---------- */

test("N3 bypassed is not a false hit — the cache was never consulted", () => {
	// Build a CacheResult directly to exercise Metrics' positive criterion, the same definition
	// Evaluation uses.
	const m = createMetrics();
	const r = (outcome: Outcome): CacheResult => ({
		payload: { kind: "answer", answer: "a" },
		outcome,
		bypassReason: outcome === "bypassed" ? "依赖对话上下文" : null,
		wouldReuse: null,
		exitedAt: null,
		entryId: null,
		scope: "org:1|course:1",
		trace: [],
	});
	m.record({ result: r("bypassed") });
	m.record({ result: r("generated") });
	const s = m.snapshot();
	assert.equal(s.hits, 0, "两者都不是命中");
	assert.equal(s.byOutcome.bypassed, 1, "但要能和 generated 分开");
	assert.equal(s.byOutcome.generated, 1);
});

/* ---------- N4: both Maps are bounded ---------- */

test("N4 bypass-reason cardinality is bounded — a reason embeds the call type taken from context", async () => {
	const policy = createStructuralPolicy();
	const { cache } = harness({ policy });
	// A different call type each time, and so a different reason each time.
	for (let i = 0; i < 40; i++) {
		await cache.lookup({ matchText: "q", retrievalText: "q", context: { callType: `bogus_${i}` } });
	}
	// Check the bound on the Metrics side directly.
	const m = createMetrics({ maxDistinctKeys: 8 });
	for (let i = 0; i < 40; i++) {
		m.record({
			result: {
				payload: { kind: "answer", answer: "a" },
				outcome: "bypassed",
				bypassReason: `理由 ${i}`,
				wouldReuse: null,
				exitedAt: null,
				entryId: null,
				scope: "org:1|course:1",
				trace: [],
			},
		});
	}
	const s = m.snapshot();
	// 8 real keys plus one catch-all bucket.
	assert.ok(Object.keys(s.bypassedByReason).length <= 9, "键数必须封顶，否则长跑进程会一直涨");
	assert.equal(s.byOutcome.bypassed, 40, "但计数一条都不能丢");
	assert.ok("(other)" in s.bypassedByReason, 'overflow goes into "other"');
});

test("N4 segment keys are capped too, and existing segments keep accumulating", () => {
	const m = createMetrics({ maxDistinctKeys: 3 });
	const r: CacheResult = {
		payload: { kind: "answer", answer: "a" },
		outcome: "exact",
		bypassReason: null,
		wouldReuse: null,
		exitedAt: null,
		entryId: "e",
		scope: "org:1|course:1",
		trace: [],
	};
	for (const seg of ["a", "b", "c", "d", "e"]) {
		m.record({ result: r, segment: seg });
	}
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
