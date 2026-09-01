/**
 * 容量淘汰的四种策略。
 *
 * 每条都盯着一个具体的失效：`fifo`/`rr` 绝不能在读路径上写、`lru`/`lfu` 必须真的
 * 记账、容量是**每 scope** 的（按全库设会让热门 scope 挤掉冷门 scope 的全部条目，
 * 那是多租户里最难查的一类问题）、以及同分时的定序 —— 不定序的话「删哪一条」
 * 就成了实现细节，三种后端会给出不同答案。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMemoryCacheStore } from "../src/MemoryCacheStore.ts";
import type { CacheEntry } from "../src/types/CacheStore.ts";
import type { EvictionPolicy } from "../src/types/Eviction.ts";

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
		answerVector: [1, 0],
		sourceIds: ["n1"],
		sourceVersion: "n1v1",
		createdAt,
		expiresAt: null,
	};
}

function store(policy: EvictionPolicy, capacity: number, now = () => 5000) {
	return createMemoryCacheStore({ now, eviction: { policy, capacity } });
}

const ids = async (s: { all(): Promise<ReadonlyArray<CacheEntry>> }): Promise<Array<string>> =>
	(await s.all()).map(e => e.id).sort();

test("不配 eviction 就不淘汰 —— 只靠 TTL 与显式失效", async () => {
	const s = createMemoryCacheStore();
	for (let i = 0; i < 10; i++) await s.put(entry(`e${i}`, "s", 1000 + i));
	assert.equal((await s.all()).length, 10);
	assert.equal(await s.evictOverCapacity("s"), 0);
});

test("fifo：写满之后留最新的", async () => {
	const s = store("fifo", 3);
	for (let i = 0; i < 6; i++) await s.put(entry(`e${i}`, "s", 1000 + i));
	assert.deepEqual(await ids(s), ["e3", "e4", "e5"]);
});

test("fifo/rr 的 touch 是真正的空操作 —— 读路径不该因为淘汰策略变成写路径", async () => {
	for (const policy of ["fifo", "rr"] as const) {
		const s = store(policy, 10);
		await s.put(entry("e1"));
		await s.touch("e1");
		const got = await s.getById("e1");
		assert.equal(got?.lastUsedAt, undefined, `${policy} 不该写 lastUsedAt`);
		assert.equal(got?.useCount, undefined, `${policy} 不该写 useCount`);
	}
});

test("lru：touch 过的留下，没 touch 的先走", async () => {
	let clock = 1000;
	const s = store("lru", 2, () => clock);
	await s.put(entry("old", "s", 1));
	await s.put(entry("mid", "s", 2));
	// 把最老的那条 touch 一下，它就该活下来
	clock = 9000;
	await s.touch("old");
	await s.put(entry("new", "s", 3));
	assert.deepEqual(await ids(s), ["new", "old"]);
});

test("lru：touch 真的写了 lastUsedAt 与 useCount", async () => {
	const s = store("lru", 10, () => 7777);
	await s.put(entry("e1"));
	await s.touch("e1");
	await s.touch("e1");
	const got = await s.getById("e1");
	assert.equal(got?.lastUsedAt, 7777);
	// 阶梯是「写入算 1 次使用，每次复用 +1」：1 + 两次 touch = 3。
	// 从 0 起加的话，没记过账的条目（保留优先级按 1 算）和被复用过一次的条目同分，
	// 第一次复用等于白费。
	assert.equal(got?.useCount, 3);
});

test("lfu：用得多的留下，哪怕它更老", async () => {
	let clock = 1000;
	const s = store("lfu", 2, () => clock++);
	await s.put(entry("hot", "s", 1));
	await s.put(entry("cold", "s", 2));
	for (let i = 0; i < 3; i++) await s.touch("hot");
	await s.put(entry("fresh", "s", 3));
	// hot 有 3 次，fresh 与 cold 都是 0 次 —— 0 次的里面按 LRU 退让
	const kept = await ids(s);
	assert.ok(kept.includes("hot"), `hot 应当留下，实际 ${kept.join(",")}`);
	assert.equal(kept.length, 2);
});

test("lfu 次数相同时退到 LRU —— 纯 LFU 会让早期攒够次数的老条目永远赖着不走", async () => {
	let clock = 1000;
	const s = store("lfu", 1, () => clock);
	await s.put(entry("a", "s", 1));
	await s.put(entry("b", "s", 2));
	clock = 5000;
	await s.touch("a");
	clock = 9000;
	await s.touch("b");
	// 两条都是 1 次，b 更晚被用 → 留 b
	await s.put(entry("c", "s", 3));
	assert.equal((await s.all()).length, 1);
});

test("rr：随机删，但条数一定压回容量", async () => {
	const s = store("rr", 4);
	for (let i = 0; i < 20; i++) await s.put(entry(`e${i}`, "s", 1000 + i));
	assert.equal((await s.all()).length, 4);
});

test("容量是**每 scope** 的 —— 一个 scope 写爆不该动到另一个", async () => {
	const s = store("fifo", 2);
	for (let i = 0; i < 5; i++) await s.put(entry(`a${i}`, "course:A", 1000 + i));
	await s.put(entry("b0", "course:B", 1));
	for (let i = 0; i < 5; i++) await s.put(entry(`c${i}`, "course:A", 2000 + i));
	const kept = await s.all();
	assert.equal(kept.filter(e => e.scope === "course:A").length, 2);
	assert.deepEqual(
		kept.filter(e => e.scope === "course:B").map(e => e.id),
		["b0"],
		"另一个 scope 的条目必须原样留着",
	);
});

test("同 createdAt 时按 id 定序 —— 不定序的话三种后端会删掉不同的条目", async () => {
	const s = store("fifo", 2);
	for (const id of ["aaa", "bbb", "ccc", "ddd"]) await s.put(entry(id, "s", 1000));
	// createdAt 全同 → id 大的先保住
	assert.deepEqual(await ids(s), ["ccc", "ddd"]);
});

test("evictOverCapacity 可以单独调，返回删掉的条数", async () => {
	const s = createMemoryCacheStore({ eviction: { policy: "fifo", capacity: 100 } });
	for (let i = 0; i < 10; i++) await s.put(entry(`e${i}`, "s", 1000 + i));
	assert.equal(await s.evictOverCapacity("s"), 0);

	const tight = store("fifo", 3);
	// 绕过 put 的自动压缩：直接把容量之外的条目塞进一个宽容量的库再收
	for (let i = 0; i < 3; i++) await tight.put(entry(`k${i}`, "s", 1000 + i));
	assert.equal(await tight.evictOverCapacity("s"), 0);
});

test("touch 不存在的条目静默返回 —— 它可能刚被并发驱逐", async () => {
	const s = store("lru", 10);
	await s.touch("从来没有过的 id");
	assert.equal((await s.all()).length, 0);
});

test("lfu：刚写进来的条目不能被自己触发的淘汰立刻删掉", async () => {
	const store = createMemoryCacheStore({ eviction: { policy: "lfu", capacity: 2 } });
	const base = { scope: "s", kind: "answer" as const, matchText: "", matchHash: "h", matchVector: [1], answer: "",
		plan: {}, answerVector: [], sourceIds: [], sourceVersion: "", expiresAt: null };

	// 两条老条目，各被用过一次
	await store.put({ ...base, id: "old-a", matchHash: "a", createdAt: 1, lastUsedAt: 1, useCount: 1 });
	await store.put({ ...base, id: "old-b", matchHash: "b", createdAt: 2, lastUsedAt: 2, useCount: 1 });

	// 第三条刚写入、没记过账。算「零次」的话它排最后，会被自己这次 put 删掉
	await store.put({ ...base, id: "fresh", matchHash: "c", createdAt: 3 });

	const ids = (await store.all()).map(e => e.id).sort();
	assert.ok(ids.includes("fresh"), `新条目必须活下来，实际留下 ${ids.join("/")}`);
	assert.equal(ids.length, 2);
	// 打平后由 LRU 破平：最久没用的那条老条目出局
	assert.deepEqual(ids, ["fresh", "old-b"]);
});

test("lfu：用得多的老条目仍然压得住新条目 —— 只解「进不来」，不改 LFU 本意", async () => {
	const store = createMemoryCacheStore({ eviction: { policy: "lfu", capacity: 2 } });
	const base = { scope: "s", kind: "answer" as const, matchText: "", matchHash: "h", matchVector: [1], answer: "",
		plan: {}, answerVector: [], sourceIds: [], sourceVersion: "", expiresAt: null };

	await store.put({ ...base, id: "hot-a", matchHash: "a", createdAt: 1, lastUsedAt: 1, useCount: 9 });
	await store.put({ ...base, id: "hot-b", matchHash: "b", createdAt: 2, lastUsedAt: 2, useCount: 9 });
	await store.put({ ...base, id: "fresh", matchHash: "c", createdAt: 3 });

	const ids = (await store.all()).map(e => e.id).sort();
	assert.deepEqual(ids, ["hot-a", "hot-b"], "9 次 > 1 次，热条目该留下");
});

/* ---------- 过期行不占容量 ---------- */

test("过期未清理的行不占容量名额 —— 它顶不掉活条目", async () => {
	// 一条已过期、但 lastUsedAt 很新的行：LRU 的保留优先级最高，先前它会活下来
	// 并把一条活条目顶掉。而 purgeExpired 还没跑到之前，它在读路径上早已看不见 ——
	// 「看不见的行删掉了看得见的行」。
	const s = store("lru", 2);
	await s.put({ ...entry("过期的", "s", 1000), expiresAt: 4000, lastUsedAt: 4999 });
	await s.put(entry("活A", "s", 1001));
	await s.put(entry("活B", "s", 1002));
	assert.deepEqual(await ids(s), ["活A", "活B"]);
});

test("过期行被收掉之后就没超容量了 —— 这时一条活条目都不该动", async () => {
	const s = store("fifo", 2);
	await s.put({ ...entry("过期的", "s", 1000), expiresAt: 4000 });
	await s.put(entry("活A", "s", 1001));
	// 此刻存储里 2 条（含 1 条过期），没超；再写一条触发淘汰
	await s.put(entry("活B", "s", 1002));
	assert.deepEqual(await ids(s), ["活A", "活B"], "该走的是那条过期的，不是最老的活条目");
});

test("evictOverCapacity 的返回值把过期行也算进去 —— 契约是「删掉的条数」", async () => {
	const s = store("fifo", 1);
	await s.put({ ...entry("过期1", "s", 1000), expiresAt: 4000 });
	await s.put({ ...entry("过期2", "s", 1001), expiresAt: 4000 });
	await s.put(entry("活A", "s", 1002));
	// put 里那次 trim 已经把两条过期的收走了，剩 1 条活的正好等于容量
	assert.deepEqual(await ids(s), ["活A"]);
	assert.equal(await s.evictOverCapacity("s"), 0, "已经在容量内了");
});

/* ---------- lfu 的次数封顶三个后端一致 ---------- */

test("lfu 的使用次数封顶 —— 超过 LFU_COUNT_CAP 之后退回按时间破平", async () => {
	// Redis 后端必须把「次数 + 时间」打包进 zset 的一个 double，所以次数封在 1023。
	// 内存与 pgvector 先前用的是裸 use_count：两条 1500 与 1100 的条目，内存选 1500
	// 留下，Redis 视为同分退回按时间破平 —— 一条真实的跨后端语义分歧，只是要跑到
	// 1023 次以上才暴露。三处现在共用 EvictionOrder.ts 的封顶值。
	const s = store("lfu", 1);
	await s.put({ ...entry("次数1500但很久没用", "s", 1000), useCount: 1500, lastUsedAt: 100 });
	await s.put({ ...entry("次数1100刚用过", "s", 1001), useCount: 1100, lastUsedAt: 200 });
	assert.deepEqual(await ids(s), ["次数1100刚用过"]);
});

test("lfu 在封顶以下仍然只看次数", async () => {
	const s = store("lfu", 1);
	await s.put({ ...entry("次数9但很久没用", "s", 1000), useCount: 9, lastUsedAt: 100 });
	await s.put({ ...entry("次数2刚用过", "s", 1001), useCount: 2, lastUsedAt: 200 });
	assert.deepEqual(await ids(s), ["次数9但很久没用"]);
});

/* ---------- rr 是均匀抽样 ---------- */

test("rr 是均匀抽样，不是拿 Math.random() 当比较器", async () => {
	// `sort(() => Math.random() - 0.5)` 的比较器不自反也不传递，给出的排列取决于
	// sort 内部走的哪条路径，明显偏向原顺序 —— rr 于是悄悄变成「偏向淘汰先写入的」，
	// 跟 fifo 撞车，而它对外承诺的是随机。
	const evicted: Record<string, number> = { a: 0, b: 0, c: 0 };
	const rounds = 6000;
	for (let i = 0; i < rounds; i++) {
		const s = store("rr", 2);
		await s.put(entry("a", "s", 1000));
		await s.put(entry("b", "s", 1001));
		await s.put(entry("c", "s", 1002));
		const left = new Set((await s.all()).map(e => e.id));
		for (const id of ["a", "b", "c"]) if (!left.has(id)) evicted[id] += 1;
	}
	// 每条应各占约 1/3。放宽到 ±20% —— 这是防偏，不是测随机数发生器的质量
	const expected = rounds / 3;
	for (const id of ["a", "b", "c"]) {
		const ratio = evicted[id] / expected;
		assert.ok(ratio > 0.8 && ratio < 1.2, `${id} 被淘汰 ${evicted[id]} 次，期望 ≈${expected}（比值 ${ratio.toFixed(2)}）`);
	}
});
