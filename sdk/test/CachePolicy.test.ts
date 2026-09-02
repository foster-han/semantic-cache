/**
 * "Should this question enter the cache at all" — decided ahead of every gate.
 *
 * What is tested here are three things no gate can catch: on a bypass **not one gate may run**
 * (otherwise nothing is saved), on a bypass **nothing may be written** (otherwise the next request
 * is a false hit), and the TTL a policy sets has to land on the entry (otherwise the middle route
 * of "a short TTL rather than a full bypass" does not exist at all).
 */

import { combinePolicies, createStructuralPolicy, DEFAULT_SEMANTIC_CALL_TYPES } from "../src/CachePolicyRules.ts";
import type { CachePolicy } from "../src/types/CachePolicy.ts";
import { answering, forCosine, harness } from "./Fakes.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const ASK = { matchText: "作业怎么交？", retrievalText: "作业怎么交？", context: {} };
const FOLLOW_UP = { ...ASK, context: { needsHistory: "1" } };

const followUpPolicy: CachePolicy = createStructuralPolicy({
	bypassWhen: { needsHistory: "依赖对话上下文" },
});

test("a bypass runs no gate — the lookup side skips the recall encoding and ⑤", async () => {
	const { cache, counts } = harness({ policy: followUpPolicy });
	const found = await cache.lookup(FOLLOW_UP);
	assert.equal(found.outcome, "bypass");
	assert.equal(found.noCacheReason, "依赖对话上下文");
	assert.equal(found.noStoreReason, "依赖对话上下文");
	assert.deepEqual(found.trace, []);
	assert.equal(found.exitedAt, null);
	// Not one encoding was paid for on the lookup side. **Note this holds for lookup only** — resolve
	// still retrieves, or there would be no chunks to generate from. What is saved is ③'s encoding and
	// ⑤'s verdict, not "the whole chain".
	assert.equal(counts.questions, 0);
	assert.equal(counts.retrieve, 0);
});

test("a bypass yields no write ticket — this does not rely on the caller behaving", async () => {
	const { cache } = harness({ policy: followUpPolicy });
	const found = await cache.lookup(FOLLOW_UP);
	await assert.rejects(() => found.prepareWrite(), /judged this prompt uncacheable \(依赖对话上下文\)/u);
});

test("both switches set: generate as usual, but write nothing back", async () => {
	const { cache, store, counts } = harness({ policy: followUpPolicy });
	const result = await cache.resolve(FOLLOW_UP, answering("现学现答", counts));
	assert.equal(result.outcome, "bypassed");
	assert.equal(result.bypassReason, "依赖对话上下文");
	assert.equal(result.payload.kind === "answer" && result.payload.answer, "现学现答");
	// The precise meaning of a null entryId: it was generated, but nothing landed in the cache.
	assert.equal(result.entryId, null);
	assert.equal((await store.all()).length, 0);
	assert.equal(counts.generate, 1);

	// Asking the same question again still regenerates — because last time nothing was stored.
	await cache.resolve(FOLLOW_UP, answering("现学现答", counts));
	assert.equal(counts.generate, 2);
});

test("the same sentence without the signal caches as usual — a bypass keys on signals, not on text", async () => {
	const { cache, store } = harness({ policy: followUpPolicy });
	const first = await cache.resolve(ASK, answering("可以在线提交"));
	assert.equal(first.outcome, "generated");
	assert.notEqual(first.entryId, null);
	assert.equal((await store.all()).length, 1);

	const second = await cache.resolve(ASK, answering("不该被调用"));
	assert.equal(second.outcome, "exact");
});

test("the policy's short TTL lands on the entry — time-sensitive content need not be bypassed entirely", async () => {
	const policy = createStructuralPolicy({ shortTtlWhen: { timeSensitive: 600_000 } });
	const now = () => 1_000_000;
	// The second question needs a vector far from BASE, or it hits the first entry and never writes.
	const { cache, store } = harness({ policy, now, ttlMs: null, pair: { "什么是过拟合？": forCosine(0.1) } });

	await cache.resolve({ ...ASK, context: { timeSensitive: "1" } }, answering("本周五截止"));
	const [entry] = await store.all();
	assert.equal(entry.expiresAt, 1_000_000 + 600_000);

	// An entry without the signal still takes the global default (never expire, in this harness).
	await cache.resolve(
		{ matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} },
		answering("模型记住了噪声"),
	);
	const stable = (await store.all()).find(e => e.matchText === "什么是过拟合？");
	assert.equal(stable?.expiresAt, null);
});

test("an explicit ttlMs at write time overrides the policy's — a policy is a default, not an order", async () => {
	const policy = createStructuralPolicy({ shortTtlWhen: { timeSensitive: 600_000 } });
	const now = () => 1_000_000;
	const { cache, store } = harness({ policy, now, ttlMs: null });
	const prompt = { ...ASK, context: { timeSensitive: "1" } };
	const found = await cache.lookup(prompt);
	await cache.write(
		prompt,
		{ kind: "answer", answer: "本周五截止" },
		{
			ticket: await found.prepareWrite(),
			ttlMs: 5_000,
		},
	);
	const [entry] = await store.all();
	assert.equal(entry.expiresAt, 1_005_000);
});

test("falsy values are not signals — context holds strings, so '0'/'false' must count as unset", async () => {
	const { cache } = harness({ policy: followUpPolicy });
	for (const value of ["", "0", "false", "no", "off", " FALSE "]) {
		const found = await cache.lookup({ ...ASK, context: { needsHistory: value } });
		assert.notEqual(
			found.outcome,
			"bypass",
			`a context value of ${JSON.stringify(value)} must not trigger a bypass`,
		);
	}
	const set = await cache.lookup({ ...ASK, context: { needsHistory: "yes" } });
	assert.equal(set.outcome, "bypass");
});

test("one key in both bypass and short-TTL tables, and a non-positive TTL: both throw at construction", () => {
	assert.throws(
		() => createStructuralPolicy({ bypassWhen: { x: "理由" }, shortTtlWhen: { x: 1000 } }),
		/appears in both bypassWhen and shortTtlWhen/u,
	);
	assert.throws(
		() => createStructuralPolicy({ shortTtlWhen: { x: 0 } }),
		/is not a positive number of milliseconds/u,
	);
	assert.throws(
		() => createStructuralPolicy({ shortTtlWhen: { x: -5 } }),
		/is not a positive number of milliseconds/u,
	);
});

test("combinePolicies: the first to say bypass wins, and when all allow it the shortest TTL is taken", async () => {
	const short = createStructuralPolicy({ shortTtlWhen: { a: 10_000 } });
	const long = createStructuralPolicy({ shortTtlWhen: { a: 60_000 } });
	const veto = createStructuralPolicy({ bypassWhen: { stop: "有副作用" } });

	const merged = combinePolicies(long, short, veto);
	assert.deepEqual(await merged({ ...ASK, context: { a: "1" } }), { ttlMs: 10_000 });
	assert.deepEqual(await merged({ ...ASK, context: {} }), {});

	const stopped = await merged({ ...ASK, context: { a: "1", stop: "1" } });
	assert.equal(stopped.noCache, "有副作用");
	assert.equal(stopped.noStore, "有副作用");

	assert.throws(() => combinePolicies(), /needs at least one policy/u);
});

test("no policy means everything is cacheable — this layer is optional", async () => {
	const { cache, store } = harness();
	await cache.resolve(FOLLOW_UP, answering("照常缓存"));
	assert.equal((await store.all()).length, 1);
});

test("prepareTicket consults the policy too — otherwise it is a back door around the guard", async () => {
	const { cache } = harness({ policy: followUpPolicy });
	await assert.rejects(() => cache.prepareTicket(FOLLOW_UP), /judged this prompt uncacheable \(依赖对话上下文\)/u);
	// An allowed prompt gets its ticket as usual, carrying the policy's TTL.
	const ttlPolicy = createStructuralPolicy({ shortTtlWhen: { timeSensitive: 600_000 } });
	const other = harness({ policy: ttlPolicy });
	const ticket = await other.cache.prepareTicket({ ...ASK, context: { timeSensitive: "1" } });
	assert.equal(ticket.ttlMs, 600_000);
});

test('noCache alone is "answer again": no lookup, forced regeneration, written back over the old entry', async () => {
	const policy = createStructuralPolicy({ noCacheWhen: { regenerate: "学生要求重新回答" } });
	const { cache, store, counts } = harness({ policy });

	// Seed one entry normally first.
	await cache.resolve(ASK, answering("简略版", counts));
	const [before] = await store.all();
	assert.equal(before.answer, "简略版");

	// Clicking "answer again": the key is unchanged, only a flag is added.
	const again = await cache.resolve({ ...ASK, context: { regenerate: "1" } }, answering("详细版", counts));
	assert.equal(again.outcome, "bypassed");
	assert.equal(counts.generate, 2, "必须真的重新生成，不能返回缓存里那条");

	// The new answer is stored and the old entry is replaced rather than kept alongside it.
	const after = await store.all();
	assert.equal(after.length, 1);
	assert.equal(after[0].answer, "详细版");

	// The next student hits the improved version directly.
	const next = await cache.resolve(ASK, answering("不该被调用", counts));
	assert.equal(next.outcome, "exact");
	assert.equal(next.payload.kind === "answer" && next.payload.answer, "详细版");
	assert.equal(counts.generate, 2);
});

test("noStore alone is 'give me five practice problems': read what others left, but do not store mine", async () => {
	const policy = createStructuralPolicy({ noStoreWhen: { openEnded: "开放生成，没有唯一答案" } });
	const { cache, store, counts } = harness({ policy });
	const prompt = { ...ASK, context: { openEnded: "1" } };

	// With nothing cached: generate, but do not store.
	const first = await cache.resolve(prompt, answering("第一份练习题", counts));
	assert.equal(first.outcome, "generated", "读路径照常跑完了闸，这不是 bypass");
	assert.equal(first.entryId, null);
	assert.equal((await store.all()).length, 0);

	// The ticket is refused, so writing by hand around resolve does not get through either.
	const found = await cache.lookup(prompt);
	assert.equal(found.noStoreReason, "开放生成，没有唯一答案");
	assert.equal(found.noCacheReason, null, "noStore 不该顺手把读也关掉");
	await assert.rejects(() => found.prepareWrite(), /judged this prompt uncacheable \(开放生成，没有唯一答案\)/u);

	// Reading still works: seed the entry through a request without the flag, and a request
	// carrying it hits all the same.
	await cache.resolve(ASK, answering("别人存下的练习题", counts));
	const reused = await cache.resolve(prompt, answering("不该被调用", counts));
	assert.equal(reused.outcome, "exact");
	assert.equal(reused.payload.kind === "answer" && reused.payload.answer, "别人存下的练习题");
});

test("the call-type allowlist: kinds with deterministic output skip the semantic cache by default", async () => {
	const policy = createStructuralPolicy();
	for (const callType of ["embedding", "rerank", "transcription", "text_completion"]) {
		const d = await policy({ ...ASK, context: { callType } });
		assert.equal(d.noCache, d.noStore, `${callType} 该读写一起拦`);
		assert.match(String(d.noCache), /is not on the semantic-cache allowlist/u, `${callType} 该被拦下`);
	}
	for (const callType of DEFAULT_SEMANTIC_CALL_TYPES) {
		const d = await policy({ ...ASK, context: { callType } });
		assert.deepEqual(d, {}, `${callType} 该放行`);
	}
});

test("async variants are recognized, but anthropic_messages itself starts with an a — the prefix cannot be stripped blindly", async () => {
	const policy = createStructuralPolicy();
	// The ones stripping the prefix recognises.
	assert.deepEqual(await policy({ ...ASK, context: { callType: "acompletion" } }), {});
	assert.deepEqual(await policy({ ...ASK, context: { callType: "aresponses" } }), {});
	// The name itself starts with an a: both spellings have to be recognised.
	assert.deepEqual(await policy({ ...ASK, context: { callType: "anthropic_messages" } }), {});
	assert.deepEqual(await policy({ ...ASK, context: { callType: "aanthropic_messages" } }), {});
	// An excluded kind stays excluded in its async form.
	const embedded = await policy({ ...ASK, context: { callType: "aembedding" } });
	assert.match(String(embedded.noStore), /is not on the semantic-cache allowlist/u);
});

test("an unlabelled call type is allowed by default, and refused once requireCallType is on", async () => {
	assert.deepEqual(await createStructuralPolicy()(ASK), {});

	const strict = createStructuralPolicy({ requireCallType: true });
	const d = await strict(ASK);
	assert.match(String(d.noCache), /no call type labelled \(context\.callType\)/u);
	assert.equal(d.noCache, d.noStore);
	// Once labelled, it is judged as usual.
	assert.deepEqual(await strict({ ...ASK, context: { callType: "completion" } }), {});
});

test("both the allowlist and the key name are configurable; an empty allowlist throws at construction", async () => {
	const policy = createStructuralPolicy({
		callTypeKey: "kind",
		allowedCallTypes: ["completion", "embedding"],
	});
	assert.deepEqual(await policy({ ...ASK, context: { kind: "embedding" } }), {}, "显式放行的就该放行");
	const reranked = await policy({ ...ASK, context: { kind: "rerank" } });
	assert.match(String(reranked.noCache), /call type "rerank" is not on the semantic-cache allowlist/u);
	// The default key name no longer applies.
	assert.deepEqual(await policy({ ...ASK, context: { callType: "rerank" } }), {}, "换了键名后旧键不该被读");

	assert.throws(() => createStructuralPolicy({ allowedCallTypes: [] }), /disables the entire cache/u);
});

test("for a request the allowlist refuses, lookup runs no gate and the reason reaches the dashboard", async () => {
	const { cache, counts } = harness({ policy: createStructuralPolicy() });
	const found = await cache.lookup({ ...ASK, context: { callType: "embedding" } });
	assert.equal(found.outcome, "bypass");
	assert.equal(counts.questions, 0);
	await assert.rejects(() => found.prepareWrite(), /judged this prompt uncacheable/u);

	const result = await cache.resolve(
		{ ...ASK, context: { callType: "embedding" } },
		answering("向量", counts),
	);
	assert.equal(result.outcome, "bypassed");
	assert.match(String(result.bypassReason), /call type "embedding" is not on the semantic-cache allowlist/u);
});
