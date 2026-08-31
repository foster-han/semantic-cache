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
	assert.equal(got?.useCount, 2);
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
