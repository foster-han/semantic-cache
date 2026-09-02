/**
 * The four capacity-eviction policies.
 *
 * Each test targets one specific failure: `fifo`/`rr` must never write on the read path,
 * `lru`/`lfu` must really do their bookkeeping, capacity is **per scope** (a store-wide cap would
 * let a busy scope evict every entry belonging to a quiet one — among the hardest classes of bug to
 * track down in a multi-tenant system), and ties must be ordered — without that, "which entry gets
 * deleted" becomes an implementation detail and the three backends answer differently.
 */

import { createMemoryCacheStore } from "../src/MemoryCacheStore.ts";
import type { CacheEntry } from "../src/types/CacheStore.ts";
import type { EvictionPolicy } from "../src/types/Eviction.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";

function entry(id: string, scope = "s", createdAt = 1000): CacheEntry {
	return {
		id,
		scope,
		matchText: `q-${id}`,
		matchHash: `h-${id}`,
		matchVector: [1, 0],
		kind: "answer",
		answer: `a-${id}`,
		plan: {},
		createdAt,
		expiresAt: null,
	};
}

function store(policy: EvictionPolicy, capacity: number, now = () => 5000) {
	return createMemoryCacheStore({ now, eviction: { policy, capacity } });
}

const ids = async (s: { all(): Promise<ReadonlyArray<CacheEntry>> }): Promise<Array<string>> =>
	(await s.all()).map(e => e.id).sort();

test("no eviction configured means nothing is evicted — only TTL and explicit invalidation apply", async () => {
	const s = createMemoryCacheStore();
	for (let i = 0; i < 10; i++) {
		await s.put(entry(`e${i}`, "s", 1000 + i));
	}
	assert.equal((await s.all()).length, 10);
	assert.equal(await s.evictOverCapacity("s"), 0);
});

test("fifo: once full, the newest are kept", async () => {
	const s = store("fifo", 3);
	for (let i = 0; i < 6; i++) {
		await s.put(entry(`e${i}`, "s", 1000 + i));
	}
	assert.deepEqual(await ids(s), ["e3", "e4", "e5"]);
});

test("touch is a genuine no-op under fifo/rr — an eviction policy must not turn the read path into a write path", async () => {
	for (const policy of ["fifo", "rr"] as const) {
		const s = store(policy, 10);
		await s.put(entry("e1"));
		await s.touch("e1");
		const got = await s.getById("e1");
		assert.equal(got?.lastUsedAt, undefined, `${policy} 不该写 lastUsedAt`);
		assert.equal(got?.useCount, undefined, `${policy} 不该写 useCount`);
	}
});

test("lru: what was touched stays, what was not goes first", async () => {
	let clock = 1000;
	const s = store("lru", 2, () => clock);
	await s.put(entry("old", "s", 1));
	await s.put(entry("mid", "s", 2));
	// Touch the oldest entry and it should survive.
	clock = 9000;
	await s.touch("old");
	await s.put(entry("new", "s", 3));
	assert.deepEqual(await ids(s), ["new", "old"]);
});

test("lru: touch really does write lastUsedAt and useCount", async () => {
	const s = store("lru", 10, () => 7777);
	await s.put(entry("e1"));
	await s.touch("e1");
	await s.touch("e1");
	const got = await s.getById("e1");
	assert.equal(got?.lastUsedAt, 7777);
	// The ladder is "a write counts as one use, each reuse adds one": 1 + two touches = 3.
	// Starting from 0 would tie an entry with no bookkeeping (which retention priority counts as 1)
	// against one reused once, making the first reuse count for nothing.
	assert.equal(got?.useCount, 3);
});

test("lfu: the more-used entry stays, even when it is older", async () => {
	let clock = 1000;
	const s = store("lfu", 2, () => clock++);
	await s.put(entry("hot", "s", 1));
	await s.put(entry("cold", "s", 2));
	for (let i = 0; i < 3; i++) {
		await s.touch("hot");
	}
	await s.put(entry("fresh", "s", 3));
	// hot has 3 uses, fresh and cold have 0 — among the zero-use entries, LRU decides.
	const kept = await ids(s);
	assert.ok(kept.includes("hot"), `hot 应当留下，实际 ${kept.join(",")}`);
	assert.equal(kept.length, 2);
});

test("lfu falls back to LRU on equal counts — pure LFU lets an entry that accumulated a high count early sit there forever", async () => {
	let clock = 1000;
	const s = store("lfu", 1, () => clock);
	await s.put(entry("a", "s", 1));
	await s.put(entry("b", "s", 2));
	clock = 5000;
	await s.touch("a");
	clock = 9000;
	await s.touch("b");
	// Both have one use and b was used later, so b stays.
	await s.put(entry("c", "s", 3));
	assert.equal((await s.all()).length, 1);
});

test("rr: deletes at random, but the count always comes back to capacity", async () => {
	const s = store("rr", 4);
	for (let i = 0; i < 20; i++) {
		await s.put(entry(`e${i}`, "s", 1000 + i));
	}
	assert.equal((await s.all()).length, 4);
});

test("capacity is **per scope** — one scope overflowing must not touch another", async () => {
	const s = store("fifo", 2);
	for (let i = 0; i < 5; i++) {
		await s.put(entry(`a${i}`, "course:A", 1000 + i));
	}
	await s.put(entry("b0", "course:B", 1));
	for (let i = 0; i < 5; i++) {
		await s.put(entry(`c${i}`, "course:A", 2000 + i));
	}
	const kept = await s.all();
	assert.equal(kept.filter(e => e.scope === "course:A").length, 2);
	assert.deepEqual(
		kept.filter(e => e.scope === "course:B").map(e => e.id),
		["b0"],
		"另一个 scope 的条目必须原样留着",
	);
});

test("ties on createdAt are ordered by id — without that the three backends delete different entries", async () => {
	const s = store("fifo", 2);
	for (const id of ["aaa", "bbb", "ccc", "ddd"]) {
		await s.put(entry(id, "s", 1000));
	}
	// With identical createdAt, the greater id is kept first.
	assert.deepEqual(await ids(s), ["ccc", "ddd"]);
});

test("evictOverCapacity can be called on its own and returns how many were deleted", async () => {
	const s = createMemoryCacheStore({ eviction: { policy: "fifo", capacity: 100 } });
	for (let i = 0; i < 10; i++) {
		await s.put(entry(`e${i}`, "s", 1000 + i));
	}
	assert.equal(await s.evictOverCapacity("s"), 0);

	const tight = store("fifo", 3);
	// Bypass put's automatic trim: write beyond capacity into a store with a wide limit, then collect.
	for (let i = 0; i < 3; i++) {
		await tight.put(entry(`k${i}`, "s", 1000 + i));
	}
	assert.equal(await tight.evictOverCapacity("s"), 0);
});

test("touching a missing entry returns silently — it may have just been evicted concurrently", async () => {
	const s = store("lru", 10);
	await s.touch("从来没有过的 id");
	assert.equal((await s.all()).length, 0);
});

test("lfu: a freshly written entry must not be deleted immediately by the eviction its own write triggered", async () => {
	const store = createMemoryCacheStore({ eviction: { policy: "lfu", capacity: 2 } });
	const base = {
		scope: "s",
		kind: "answer" as const,
		matchText: "",
		matchHash: "h",
		matchVector: [1],
		answer: "",
		plan: {},
		expiresAt: null,
	};

	// Two old entries, each used once.
	await store.put({ ...base, id: "old-a", matchHash: "a", createdAt: 1, lastUsedAt: 1, useCount: 1 });
	await store.put({ ...base, id: "old-b", matchHash: "b", createdAt: 2, lastUsedAt: 2, useCount: 1 });

	// The third was just written and has no bookkeeping. Counted as zero uses it sorts last and is
	// deleted by its own put.
	await store.put({ ...base, id: "fresh", matchHash: "c", createdAt: 3 });

	const ids = (await store.all()).map(e => e.id).sort();
	assert.ok(ids.includes("fresh"), `新条目必须活下来，实际留下 ${ids.join("/")}`);
	assert.equal(ids.length, 2);
	// After the tie, LRU breaks it: the least recently used old entry goes.
	assert.deepEqual(ids, ["fresh", "old-b"]);
});

test("lfu: a heavily used old entry still outranks a new one — only the cannot-get-in half is fixed, LFU's intent is unchanged", async () => {
	const store = createMemoryCacheStore({ eviction: { policy: "lfu", capacity: 2 } });
	const base = {
		scope: "s",
		kind: "answer" as const,
		matchText: "",
		matchHash: "h",
		matchVector: [1],
		answer: "",
		plan: {},
		expiresAt: null,
	};

	await store.put({ ...base, id: "hot-a", matchHash: "a", createdAt: 1, lastUsedAt: 1, useCount: 9 });
	await store.put({ ...base, id: "hot-b", matchHash: "b", createdAt: 2, lastUsedAt: 2, useCount: 9 });
	await store.put({ ...base, id: "fresh", matchHash: "c", createdAt: 3 });

	const ids = (await store.all()).map(e => e.id).sort();
	assert.deepEqual(ids, ["hot-a", "hot-b"], "9 uses beats 1, so the hot entries should stay");
});

/* ---------- Expired rows occupy no capacity ---------- */

test("an expired-but-uncleaned row occupies no capacity slot — it cannot push out a live entry", async () => {
	// A row that has expired but has a very recent lastUsedAt: LRU gives it the highest retention
	// priority, so it used to survive and push out a live entry — while being long invisible on the
	// read path, since purgeExpired had not run yet. "An invisible row deleted a visible one".
	const s = store("lru", 2);
	await s.put({ ...entry("过期的", "s", 1000), expiresAt: 4000, lastUsedAt: 4999 });
	await s.put(entry("活A", "s", 1001));
	await s.put(entry("活B", "s", 1002));
	assert.deepEqual(await ids(s), ["活A", "活B"]);
});

test("once expired rows are collected there is no overflow left — and then not one live entry should move", async () => {
	const s = store("fifo", 2);
	await s.put({ ...entry("过期的", "s", 1000), expiresAt: 4000 });
	await s.put(entry("活A", "s", 1001));
	// The store now holds 2 rows (one expired), which is not over capacity; one more write triggers
	// eviction.
	await s.put(entry("活B", "s", 1002));
	assert.deepEqual(await ids(s), ["活A", "活B"], "the expired row should go, not the oldest live entry");
});

test('evictOverCapacity counts expired rows in its return value — the contract is "how many were deleted"', async () => {
	const s = store("fifo", 1);
	await s.put({ ...entry("过期1", "s", 1000), expiresAt: 4000 });
	await s.put({ ...entry("过期2", "s", 1001), expiresAt: 4000 });
	await s.put(entry("活A", "s", 1002));
	// The trim inside put already collected both expired rows, leaving one live entry exactly at
	// capacity.
	assert.deepEqual(await ids(s), ["活A"]);
	assert.equal(await s.evictOverCapacity("s"), 0, "already within capacity");
});

/* ---------- lfu's count cap is identical across the three backends ---------- */

test("lfu caps the use count — past LFU_COUNT_CAP it falls back to breaking ties by time", async () => {
	// The Redis backend has to pack count and time into a single zset double, so the count caps at
	// 1023. Memory and pgvector used to use the raw use_count: given entries with counts 1500 and
	// 1100, memory keeps the 1500 one while Redis sees a tie and falls back to breaking it by time —
	// a genuine cross-backend semantic divergence, which only shows up past 1023 uses. All three now
	// share the cap in EvictionOrder.ts.
	const s = store("lfu", 1);
	await s.put({ ...entry("次数1500但很久没用", "s", 1000), useCount: 1500, lastUsedAt: 100 });
	await s.put({ ...entry("次数1100刚用过", "s", 1001), useCount: 1100, lastUsedAt: 200 });
	assert.deepEqual(await ids(s), ["次数1100刚用过"]);
});

test("below the cap, lfu still orders on count alone", async () => {
	const s = store("lfu", 1);
	await s.put({ ...entry("次数9但很久没用", "s", 1000), useCount: 9, lastUsedAt: 100 });
	await s.put({ ...entry("次数2刚用过", "s", 1001), useCount: 2, lastUsedAt: 200 });
	assert.deepEqual(await ids(s), ["次数9但很久没用"]);
});

/* ---------- rr samples uniformly ---------- */

test("rr is a uniform draw, not Math.random() used as a comparator", async () => {
	// The comparator in `sort(() => Math.random() - 0.5)` is neither reflexive nor transitive, so
	// the permutation it yields depends on which path sort takes internally and leans heavily
	// toward the original order — quietly turning rr into "evict what was written first", the same
	// behaviour as fifo, while the documented promise is randomness.
	const evicted: Record<string, number> = { a: 0, b: 0, c: 0 };
	const rounds = 6000;
	for (let i = 0; i < rounds; i++) {
		const s = store("rr", 2);
		await s.put(entry("a", "s", 1000));
		await s.put(entry("b", "s", 1001));
		await s.put(entry("c", "s", 1002));
		const left = new Set((await s.all()).map(e => e.id));
		for (const id of ["a", "b", "c"]) {
			if (!left.has(id)) {
				evicted[id] += 1;
			}
		}
	}
	// Each entry should take roughly a third. The ±20% slack is deliberate: this guards against
	// bias, it does not measure the quality of the random number generator.
	const expected = rounds / 3;
	for (const id of ["a", "b", "c"]) {
		const ratio = evicted[id] / expected;
		assert.ok(
			ratio > 0.8 && ratio < 1.2,
			`${id} 被淘汰 ${evicted[id]} 次，期望 ≈${expected}（比值 ${ratio.toFixed(2)}）`,
		);
	}
});
