/**
 * Regressions in **pairs** of switches.
 *
 * This batch of bugs all looked the same: policy, shadow, the mid band and tickets each had tests
 * of their own, and no combination did. Every orthogonal switch added doubles the combinations
 * while only the diagonal was covered — what follows fills in the off-diagonal.
 */

import { createStructuralPolicy } from "../src/CachePolicyRules.ts";
import { createMemoryCacheStore } from "../src/MemoryCacheStore.ts";
import { answering, harness } from "./Fakes.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const ASK = { matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} };
const noStore = createStructuralPolicy({ noStoreWhen: { openEnded: "开放生成" } });
const OPEN = { ...ASK, context: { openEnded: "1" } };

/* ---------- F1: a write without a ticket still goes through the policy ---------- */

test("F1 write() without a ticket still goes through the policy — otherwise the guard is only a suggestion", async () => {
	const { cache, store } = harness({ policy: noStore });
	await assert.rejects(
		() => cache.write(OPEN, { kind: "answer", answer: "偷偷写进去" }),
		/judged this prompt uncacheable \(开放生成\)/u,
		"a direct write is a front door and must be closed too",
	);
	assert.equal((await store.all()).length, 0);

	// An allowed prompt still stores as usual.
	await cache.write(ASK, { kind: "answer", answer: "正常的" });
	assert.equal((await store.all()).length, 1);
});

test("F1 one entry refused by the policy makes writeMany throw before storing anything — no half batch", async () => {
	const { cache, store } = harness({ policy: noStore });
	await assert.rejects(
		() =>
			cache.writeMany([
				{ prompt: ASK, payload: { kind: "answer", answer: "好的" } },
				{ prompt: OPEN, payload: { kind: "answer", answer: "该被挡" } },
			]),
		/judged this prompt uncacheable/u,
	);
	assert.equal((await store.all()).length, 0, "守卫在 put 之前，不该留下污染");
});

/* ---------- F2: shadow mode's read-only promise has to hold on the write path too ---------- */

/**
 * The suppression used to have two triggers: a downgraded hit, and a **negative verdict from ⑤/⑥**
 * on an existing entry. Both of those gates are gone, so a downgraded hit is the only trigger left
 * — but the invariant it protects is unchanged, and it is the write path that breaks it: the
 * deduplication inside `writeMany` evicts the row sharing that `(scope, matchHash)` as a duplicate.
 */
test("F2 shadow mode plus a would-be hit: even a completed resolve must not displace the entry", async () => {
	const store = createMemoryCacheStore();
	await harness({ store }).cache.resolve(ASK, answering("原答案"));
	const [before] = await store.all();

	const shadowed = harness({ store, shadow: true });
	// The point: this goes through resolve rather than lookup. The earlier tests called only
	// lookup and missed this half of the write path.
	const result = await shadowed.cache.resolve(ASK, answering("影子里新生成的"));

	assert.equal(result.outcome, "generated");
	assert.equal(result.wouldReuse, true, "本来会命中 —— 影子模式的分子要算上它");
	const after = await store.all();
	assert.equal(after.length, 1, "写入的去重会把同 hash 的旧条目当 duplicate 驱逐 —— 必须挡住");
	assert.equal(after[0].id, before.id);
	assert.equal(after[0].answer, "原答案");
});

test("F2 in shadow mode a genuine miss writes as usual — only the cases that would collide with deduplication are suppressed", async () => {
	const store = createMemoryCacheStore();
	const { cache } = harness({ store, shadow: true });
	await cache.resolve(ASK, answering("第一次"));
	assert.equal((await store.all()).length, 1, "③ 无候选的真未命中不该被抑制");
});

test("F2 shadow mode plus a policy bypass: no gate ran, and the write is skipped along with it", async () => {
	const store = createMemoryCacheStore();
	const policy = createStructuralPolicy({ noCacheWhen: { regenerate: "重新回答" } });
	const { cache } = harness({ store, shadow: true, policy });
	const result = await cache.resolve({ ...ASK, context: { regenerate: "1" } }, answering("影子里的重生成"));
	assert.equal(result.outcome, "bypassed");
	assert.equal((await store.all()).length, 0, "没跑闸就不知道会不会顶掉现有条目，保守不写");
});

/* ---------- F3: noStore plus the mid band plus refine ---------- */

test("F5 shadow plus noStore plus a would-be hit: wouldReuse must be true", async () => {
	const store = createMemoryCacheStore();
	await harness({ store }).cache.resolve(ASK, answering("原答案"));

	const { cache } = harness({ store, shadow: true, policy: noStore });
	const result = await cache.resolve(OPEN, answering("影子里新生成的"));
	// noStore governs writing, not reading — this request would have reused, and reporting false
	// would understate shadow mode's numerator.
	assert.equal(result.wouldReuse, true);
	assert.equal((await store.all()).length, 1);
});

/* ---------- F6: exitedAt is consistent across the branches ---------- */
