/**
 * 存储接口一致性。
 *
 * `compareStores.ts` 比的是端到端结论，走的只有 `resolve` 那条路，`getById` 和
 * `evictBySource` 根本碰不到。这里直接对着 `InspectableCacheStore` 的十个方法（热路径 8 个 + `all` / `clear`）跑同一串操作，
 * 两种后端的可观察结果必须逐项相同。
 *
 * 重点覆盖三处容易在真库上写错、而内存实现天然不会错的地方：
 *   - 过期过滤要在 WHERE 里（LIMIT 先生效，应用层筛就晚了）
 *   - scope 必须参与筛选，不能只靠向量距离
 *   - 召回相似度 `1 - (v <=> q)` 要等于 `VectorMath.cosine`
 *
 *   npm run store-conformance
 */
import { createMemoryCacheStore, type CacheEntry, type InspectableCacheStore } from "../../sdk/src/index.ts";
import { createLabStore } from "../Store.ts";

const DIM = 8;

function vec(seed: number): Array<number> {
	return Array.from({ length: DIM }, (_, i) => Math.sin(seed * (i + 1)));
}

function entry(id: string, scope: string, hash: string, seed: number, sources: Array<string>, expiresAt: number | null): CacheEntry {
	return {
		id,
		scope,
		matchText: `问题 ${id}`,
		matchHash: hash,
		matchVector: vec(seed),
		kind: "answer",
		answer: `答案 ${id}`,
		plan: {},
		answerVector: vec(seed + 100),
		sourceIds: sources,
		sourceVersion: sources.map(s => `${s}v1`).join(","),
		createdAt: 1_000 + seed,
		expiresAt,
		meta: { note: `m${id}` },
	};
}

/**
 * plan 条目：**没有答案向量、没有 sourceIds、没有 meta。**
 *
 * 这一支最容易在真库上分叉，因为三种后端对「空」的落法完全不同：pgvector 存不了
 * 0 维向量所以落 NULL、Redis 落字符串 `"[]"`、内存就是空数组；`meta: undefined`
 * 那边同理（NULL / 空串 / undefined）。往返回来必须都是同一个形状，否则
 * 「换存储不改判定」在 plan 这一支就是空话 —— 而 `compareStores.ts` 走的场景集
 * 全是 answer，永远碰不到它。
 */
function planEntry(id: string, scope: string, hash: string, seed: number): CacheEntry {
	return {
		id,
		scope,
		matchText: `工具问题 ${id}`,
		matchHash: hash,
		matchVector: vec(seed),
		kind: "plan",
		answer: "",
		plan: { tool: "getGrade", assignment: "2" },
		answerVector: [],
		sourceIds: [],
		sourceVersion: "",
		createdAt: 1_000 + seed,
		expiresAt: null,
	};
}

/** 一次完整的生命周期。返回的字符串就是判据 —— 两种后端必须一模一样。 */
async function run(store: InspectableCacheStore, now: () => number): Promise<Array<string>> {
	const out: Array<string> = [];
	await store.clear();

	await store.put(entry("a", "course:1", "h-a", 1, ["n1"], null));
	await store.put(entry("b", "course:1", "h-b", 2, ["n1", "n2"], null));
	await store.put(entry("c", "course:2", "h-a", 3, ["n1"], null));
	// 已过期：任何读路径都不该看见它，但 all() 要看得见
	await store.put(entry("d", "course:1", "h-d", 4, ["n3"], now() - 1));

	out.push(`all=${(await store.all()).map(e => e.id).join(",")}`);
	out.push(`byHash(course:1,h-a)=${(await store.getByHash("course:1", "h-a"))?.id ?? "null"}`);
	// 同一个哈希在另一个 scope 下是另一条 —— scope 必须参与筛选
	out.push(`byHash(course:2,h-a)=${(await store.getByHash("course:2", "h-a"))?.id ?? "null"}`);
	out.push(`byHash(course:1,h-d 已过期)=${(await store.getByHash("course:1", "h-d"))?.id ?? "null"}`);
	out.push(`byId(a)=${(await store.getById("a"))?.id ?? "null"}`);
	out.push(`byId(d 已过期)=${(await store.getById("d"))?.id ?? "null"}`);
	out.push(`byId(不存在)=${(await store.getById("zzz"))?.id ?? "null"}`);

	// 标量字段要逐字往返，尤其是 bigint（驱动会给字符串）、text[] 和 jsonb
	const roundtrip = await store.getById("b");
	out.push(
		`往返 b: text=${roundtrip?.matchText} sources=${roundtrip?.sourceIds.join("|")} ` +
			`version=${roundtrip?.sourceVersion} created=${roundtrip?.createdAt} meta=${JSON.stringify(roundtrip?.meta)}`,
	);
	/**
	 * 向量**不能**要求逐位相等：pgvector 的 `vector` 是 float4，Redis 的 vectorset
	 * 加了 `NOQUANT` 也只是 float32，而 JS 的 number 是 float8——写进去就被舍到
	 * 单精度了（0.7568024953 → 0.75680250）。这不是实现缺陷，是类型本身的分辨率，
	 * 所以判据只能是「在 float4 分辨率内」。三种后端都要满足它 ——
	 * 内存偏差为 0，pgvector 约 6e-8，Redis 约 4e-9。
	 *
	 * Redis 那边**必须显式 NOQUANT**：`VADD` 默认按 Q8 量化，int8 的分辨率过不了这条。
	 */
	const expected = vec(2);
	const drift = Math.max(...(roundtrip?.matchVector ?? []).map((v, i) => Math.abs(v - expected[i])));
	out.push(`往返 b 向量: ${drift <= 1e-7 ? "在 float4 分辨率内" : `偏差 ${drift.toExponential(2)} 超出 float4 分辨率`}`);

	/* plan 条目的往返：空向量、空数组、缺省 meta 都必须原样回来 */
	await store.put(planEntry("p", "course:1", "h-p", 7));
	const plan = await store.getById("p");
	out.push(
		`往返 p(plan): kind=${plan?.kind} answer="${plan?.answer}" plan=${JSON.stringify(plan?.plan)} ` +
			`answerVector=${JSON.stringify(plan?.answerVector)} sources=${JSON.stringify(plan?.sourceIds)} ` +
			`version="${plan?.sourceVersion}" meta=${plan?.meta === undefined ? "undefined" : JSON.stringify(plan.meta)}`,
	);
	out.push(`byHash(course:1,h-p)=${(await store.getByHash("course:1", "h-p"))?.id ?? "null"}`);
	// plan 条目照样要能被召回（它的 match_vector 是正常的，只有答案侧是空的）
	out.push(`near(plan 也在)=${(await store.searchNearest("course:1", vec(7), 5)).some(c => c.entry.id === "p") ? "在" : "不在"}`);
	await store.evict("p");

	// 召回：过期的 d 不能出现；LIMIT 也不能被它挤掉一格
	const near = await store.searchNearest("course:1", vec(2), 3);
	out.push(`near=${near.map(c => `${c.entry.id}:${c.similarity.toFixed(6)}`).join(" ")}`);
	out.push(`near(空 scope)=${(await store.searchNearest("course:9", vec(1), 3)).length}`);

	out.push(`evictBySource(n2)=${await store.evictBySource("n2")}`);
	out.push(`剩余=${(await store.all()).map(e => e.id).join(",")}`);
	await store.evict("a");
	out.push(`evict(a) 后=${(await store.all()).map(e => e.id).join(",")}`);
	out.push(`evictBySource(不存在)=${await store.evictBySource("nope")}`);

	// clearScope 只清一个 scope，别的 scope 不能被牵连
	await store.put(entry("e", "course:2", "h-e", 5, ["n4"], null));
	out.push(`clearScope(course:2)=${await store.clearScope("course:2")}`);
	out.push(`clearScope 后=${(await store.all()).map(e => e.id).join(",")}`);
	out.push(`clearScope(空 scope)=${await store.clearScope("course:9")}`);

	/* 同 (scope, matchHash) 多条 —— 并发写入会造出来，取哪一条必须确定 */
	await store.clear();
	await store.put(entry("old", "course:1", "dup", 1, ["n1"], null));
	await store.put(entry("new", "course:1", "dup", 2, ["n1"], null));
	out.push(`重复哈希 getByHash=${(await store.getByHash("course:1", "dup"))?.id ?? "null"}`);

	/**
	 * **同毫秒的兜底排序**：createdAt 相同时取 id 最大的那条。
	 * 三种后端在这里的写法各不相同（内存 `e.id > best.id`、pgvector
	 * `ORDER BY created_at DESC, id DESC`、Redis 靠 zset 同分时的字典序 + ZREVRANGE），
	 * 而这条契约先前没有任何测试碰过 —— 三者一旦分叉，② 命中的就是不同的答案。
	 */
	await store.clear();
	const sameMs = { ...entry("aaa", "course:1", "tie", 1, ["n1"], null), createdAt: 4_242 };
	await store.put(sameMs);
	await store.put({ ...sameMs, id: "zzz", answer: "同毫秒 大 id" });
	await store.put({ ...sameMs, id: "mmm", answer: "同毫秒 中 id" });
	out.push(`同毫秒 getByHash=${(await store.getByHash("course:1", "tie"))?.id ?? "null"}`);

	/* id 重复必须抛错，不能静默丢弃也不能覆盖 —— 拿一个**库里已有**的 id 去写 */
	let duplicateRejected = "没有抛错";
	try {
		await store.put(entry("zzz", "course:1", "other", 9, ["n1"], null));
	} catch {
		duplicateRejected = "抛错";
	}
	out.push(`put 同 id 两次=${duplicateRejected}　库里 ${(await store.all()).length} 条`);

	/* purgeExpired 只删过期的 */
	await store.put(entry("gone", "course:1", "h-gone", 6, ["n1"], now() - 1));
	out.push(`purgeExpired=${await store.purgeExpired()}`);
	out.push(`purge 后=${(await store.all()).map(e => e.id).join(",")}`);

	await store.clear();
	out.push(`clear 后=${(await store.all()).length}`);
	return out;
}

const now = () => 5_000;
const backing = await createLabStore({ dimensions: { match: DIM, answer: DIM }, now });
if (backing.kind === "memory") {
	throw new Error(
		"这个脚本要内存之外的后端也在。请设 SEMCACHE_DB 或 SEMCACHE_REDIS，" +
			"或直接用 npm run store-conformance / store-conformance:redis。",
	);
}

const memory = await run(createMemoryCacheStore({ now }), now);
const real = await run(backing.store, now);
await backing.close();

let bad = 0;
for (let i = 0; i < Math.max(memory.length, real.length); i++) {
	const same = memory[i] === real[i];
	if (!same) bad += 1;
	console.log(`${same ? "✓" : "✗"} ${memory[i] ?? "(内存无此项)"}`);
	if (!same) console.log(`   ${backing.kind}: ${real[i] ?? "(该后端无此项)"}`);
}
console.log(bad === 0 ? `\n${memory.length} 项全部一致。` : `\n${bad} 项不一致。`);
process.exit(bad === 0 ? 0 : 1);
