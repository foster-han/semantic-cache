/**
 * 存储接口一致性。
 *
 * `compareStores.ts` 比的是端到端结论，走的只有 `resolve` 那条路，`getById`、`clearScope`、
 * `purgeExpired` 根本碰不到。这里直接对着 `InspectableCacheStore` 的每一个方法跑同一串操作，
 * 两种后端的可观察结果必须逐项相同。
 *
 * 重点覆盖三处容易在真库上写错、而内存实现天然不会错的地方：
 *   - 过期过滤要在 WHERE 里（LIMIT 先生效，应用层筛就晚了）
 *   - scope 必须参与筛选，不能只靠向量距离
 *   - 召回相似度 `1 - (v <=> q)` 要等于 `VectorMath.cosine`
 *
 *   npm run store-conformance
 */
import { createMemoryCacheStore, LFU_COUNT_CAP, type CacheEntry, type InspectableCacheStore } from "../../sdk/src/index.ts";
import { createLabStore } from "../Store.ts";

const DIM = 8;

function vec(seed: number): Array<number> {
	return Array.from({ length: DIM }, (_, i) => Math.sin(seed * (i + 1)));
}

function entry(id: string, scope: string, hash: string, seed: number, expiresAt: number | null): CacheEntry {
	return {
		id,
		scope,
		matchText: `问题 ${id}`,
		matchHash: hash,
		matchVector: vec(seed),
		kind: "answer",
		answer: `答案 ${id}`,
		plan: {},
		createdAt: 1_000 + seed,
		expiresAt,
		meta: { note: `m${id}` },
	};
}

/**
 * plan 条目：**答案是空串、没有 meta。**
 *
 * 这一支最容易在真库上分叉，因为三种后端对「空」的落法完全不同：`meta: undefined`
 * 在 pgvector 是 NULL、在 Redis 是空串、在内存就是 undefined。往返回来必须都是同一个
 * 形状，否则「换存储不改判定」在 plan 这一支就是空话 —— 而 `compareStores.ts` 走的
 * 场景集全是 answer，永远碰不到它。
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
		createdAt: 1_000 + seed,
		expiresAt: null,
	};
}

/** 一次完整的生命周期。返回的字符串就是判据 —— 两种后端必须一模一样。 */
async function run(store: InspectableCacheStore, now: () => number): Promise<Array<string>> {
	const out: Array<string> = [];
	await store.clear();

	await store.put(entry("a", "course:1", "h-a", 1, null));
	await store.put(entry("b", "course:1", "h-b", 2, null));
	await store.put(entry("c", "course:2", "h-a", 3, null));
	// 已过期：任何读路径都不该看见它，但 all() 要看得见
	await store.put(entry("d", "course:1", "h-d", 4, now() - 1));

	out.push(`all=${(await store.all()).map(e => e.id).join(",")}`);
	out.push(`byHash(course:1,h-a)=${(await store.getByHash("course:1", "h-a"))?.id ?? "null"}`);
	// 同一个哈希在另一个 scope 下是另一条 —— scope 必须参与筛选
	out.push(`byHash(course:2,h-a)=${(await store.getByHash("course:2", "h-a"))?.id ?? "null"}`);
	out.push(`byHash(course:1,h-d 已过期)=${(await store.getByHash("course:1", "h-d"))?.id ?? "null"}`);
	out.push(`byId(a)=${(await store.getById("a"))?.id ?? "null"}`);
	out.push(`byId(d 已过期)=${(await store.getById("d"))?.id ?? "null"}`);
	out.push(`byId(不存在)=${(await store.getById("zzz"))?.id ?? "null"}`);

	// 标量字段要逐字往返，尤其是 bigint（驱动会给字符串）和 jsonb
	const roundtrip = await store.getById("b");
	out.push(
		`往返 b: text=${roundtrip?.matchText} created=${roundtrip?.createdAt} meta=${JSON.stringify(roundtrip?.meta)}`,
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
			`meta=${plan?.meta === undefined ? "undefined" : JSON.stringify(plan.meta)}`,
	);
	out.push(`byHash(course:1,h-p)=${(await store.getByHash("course:1", "h-p"))?.id ?? "null"}`);
	// plan 条目照样要能被召回
	out.push(`near(plan 也在)=${(await store.searchNearest("course:1", vec(7), 5)).some(c => c.entry.id === "p") ? "在" : "不在"}`);
	await store.evict("p");

	// 召回：过期的 d 不能出现；LIMIT 也不能被它挤掉一格
	const near = await store.searchNearest("course:1", vec(2), 3);
	out.push(`near=${near.map(c => `${c.entry.id}:${c.similarity.toFixed(6)}`).join(" ")}`);
	out.push(`near(空 scope)=${(await store.searchNearest("course:9", vec(1), 3)).length}`);

	await store.evict("a");
	out.push(`evict(a) 后=${(await store.all()).map(e => e.id).join(",")}`);
	out.push(`evict(不存在) 不抛`);
	await store.evict("nope");

	// clearScope 只清一个 scope，别的 scope 不能被牵连
	await store.put(entry("e", "course:2", "h-e", 5, null));
	out.push(`clearScope(course:2)=${await store.clearScope("course:2")}`);
	out.push(`clearScope 后=${(await store.all()).map(e => e.id).join(",")}`);
	out.push(`clearScope(空 scope)=${await store.clearScope("course:9")}`);

	/* 同 (scope, matchHash) 多条 —— 并发写入会造出来，取哪一条必须确定 */
	await store.clear();
	await store.put(entry("old", "course:1", "dup", 1, null));
	await store.put(entry("new", "course:1", "dup", 2, null));
	out.push(`重复哈希 getByHash=${(await store.getByHash("course:1", "dup"))?.id ?? "null"}`);

	/**
	 * **同毫秒的兜底排序**：createdAt 相同时取 id 最大的那条。
	 * 三种后端在这里的写法各不相同（内存 `e.id > best.id`、pgvector
	 * `ORDER BY created_at DESC, id DESC`、Redis 靠 zset 同分时的字典序 + ZREVRANGE），
	 * 而这条契约先前没有任何测试碰过 —— 三者一旦分叉，② 命中的就是不同的答案。
	 */
	await store.clear();
	const sameMs = { ...entry("aaa", "course:1", "tie", 1, null), createdAt: 4_242 };
	await store.put(sameMs);
	await store.put({ ...sameMs, id: "zzz", answer: "同毫秒 大 id" });
	await store.put({ ...sameMs, id: "mmm", answer: "同毫秒 中 id" });
	out.push(`同毫秒 getByHash=${(await store.getByHash("course:1", "tie"))?.id ?? "null"}`);

	/* id 重复必须抛错，不能静默丢弃也不能覆盖 —— 拿一个**库里已有**的 id 去写 */
	let duplicateRejected = "没有抛错";
	try {
		await store.put(entry("zzz", "course:1", "other", 9, null));
	} catch {
		duplicateRejected = "抛错";
	}
	out.push(`put 同 id 两次=${duplicateRejected}　库里 ${(await store.all()).length} 条`);

	/* purgeExpired 只删过期的 */
	await store.put(entry("gone", "course:1", "h-gone", 6, now() - 1));
	out.push(`purgeExpired=${await store.purgeExpired()}`);
	out.push(`purge 后=${(await store.all()).map(e => e.id).join(",")}`);

	/* touch：fifo/rr 必须是真空操作，lru/lfu 必须真记账。
	   这一条只在配了 eviction 的库上有意义，所以放在末尾单独跑（见 evictionRun）。 */
	await store.clear();
	out.push(`clear 后=${(await store.all()).length}`);
	return out;
}

const now = () => 5_000;
const backing = await createLabStore({ dimensions: { match: DIM }, now });
if (backing.kind === "memory") {
	throw new Error(
		"这个脚本要内存之外的后端也在。请设 SEMCACHE_DB 或 SEMCACHE_REDIS，" +
			"或直接用 npm run store-conformance / store-conformance:redis。",
	);
}

/**
 * 淘汰策略的一致性。**四种策略在三个后端必须给出同一批留存 id** ——
 * `rr` 例外（它的语义就是随机），只比条数。
 *
 * 不定序的话「删哪一条」就成了实现细节，换后端结果就变，而那种差异只会在
 * 缓存被写爆之后才显形 —— 最难查的一类。
 */
async function evictionRun(policy: "fifo" | "rr" | "lru" | "lfu", s: InspectableCacheStore): Promise<Array<string>> {
	const out: Array<string> = [];
	await s.clear();

	/**
	 * **先把容量填满，再 touch，最后写第 4 条。**
	 *
	 * 先前的写法是连写 6 条再 touch —— 那时要 touch 的条目早被淘汰了，
	 * `touch` 打在不存在的 id 上静默返回，于是 lru/lfu 跑出和 fifo 一样的结果、
	 * 记账也是「无」。四种策略"一致"但一致地什么都没测到。
	 */
	for (let i = 0; i < 3; i++) await s.put(entry(`e${i}`, "course:1", `h-${i}`, i + 1, null));
	await s.touch("e0");
	await s.touch("e0");
	await s.touch("e1");
	await s.put(entry("e3", "course:1", "h-3", 4, null));

	const kept = (await s.all()).map(x => x.id).sort();
	out.push(policy === "rr" ? `${policy}: 留 ${kept.length} 条（随机，只比条数）` : `${policy}: ${kept.join(",")}`);

	// fifo/rr 不该在读路径写入；lru/lfu 必须真记账
	const probe = await s.getById("e0");
	const accounted = probe?.lastUsedAt !== undefined || probe?.useCount !== undefined;
	out.push(`${policy}: e0 记账=${accounted ? `有(次数 ${probe?.useCount ?? "-"})` : "无"}`);

	/**
	 * 新条目会不会被自己触发的那次淘汰立刻删掉。
	 *
	 * 三个后端都把「没记过账」算成**用过一次**（不是零次），所以它应当留下 ——
	 * 算零次的话它排在所有被 touch 过的条目之后，`resolve` 返回的 entryId 会指向
	 * 一条已经不存在的记录，而那个问题在这个 scope 里永远立不住。
	 * 「用得多的老条目压着新条目」是 LFU 固有的，那半边没治，要衰减才治得了。
	 */
	if (policy === "lfu") {
		await s.put(entry("brandnew", "course:1", "h-new", 99, null));
		const after = (await s.all()).map(x => x.id);
		out.push(`lfu: 新条目留下了吗=${after.includes("brandnew") ? "留下" : "**立刻被淘汰**"}`);

		/**
		 * **使用次数封顶（`LFU_COUNT_CAP`）必须三个后端一致。**
		 *
		 * Redis 要把「次数 + 时间」打包进 zset 的一个 double，所以次数封在 1023；
		 * 内存与 pgvector 先前用的是裸 `use_count`。两条 1500 与 1100 的条目，
		 * 封顶之后应当同分、退回按时间破平 —— 不封顶的那两个后端会选 1500 那条。
		 * 一条真实存在的分歧，只是要跑到 1023 次以上才显形，所以一直没被撞上。
		 */
		await s.clear();
		const capped = `${LFU_COUNT_CAP + 477}`;
		await s.put({ ...entry("超封顶但很久没用", "course:1", "h-cap1", 11, null), useCount: LFU_COUNT_CAP + 477, lastUsedAt: 100 });
		await s.put({ ...entry("刚过封顶但刚用过", "course:1", "h-cap2", 12, null), useCount: LFU_COUNT_CAP + 77, lastUsedAt: 200 });
		await s.put({ ...entry("填位1", "course:1", "h-cap3", 13, null), useCount: 1, lastUsedAt: 150 });
		await s.put({ ...entry("填位2", "course:1", "h-cap4", 14, null), useCount: 1, lastUsedAt: 160 });
		out.push(`lfu: 次数 ${capped} 与 ${LFU_COUNT_CAP + 77} 封顶后同分 → 留 ${(await s.all()).map(x => x.id).sort().join(",")}`);
	}

	/**
	 * **过期未清理的行不占容量名额。**
	 *
	 * 一条已过期、但「最近用过」的行：`lru`/`lfu` 的保留优先级最高，先前它会活下来
	 * 并把一条活条目顶掉 —— 一条读路径上早已看不见的行，删掉了看得见的行。
	 * 三个后端先前都是这个毛病，所以这一条不是回归测试，是新增的共同判据。
	 */
	await s.clear();
	await s.put({ ...entry("过期但最近用过", "course:1", "h-x0", 21, 4_000), lastUsedAt: 4_999, useCount: 9 });
	for (let i = 1; i <= 3; i++) {
		await s.put({ ...entry(`活${i}`, "course:1", `h-x${i}`, 21 + i, null), lastUsedAt: 1_000 + i, useCount: 1 });
	}
	const survivors = (await s.all()).map(x => x.id).sort();
	out.push(
		policy === "rr"
			? `${policy}: 过期行不占名额 → 留 ${survivors.length} 条，其中过期的还在吗=${survivors.includes("过期但最近用过") ? "**还在**" : "已收走"}`
			: `${policy}: 过期行不占名额 → ${survivors.join(",")}`,
	);

	/**
	 * **容量以下显式调 `evictOverCapacity` 必须返回 0，三个后端一样。**
	 *
	 * 内存与 Redis 先「数一次，没超就返回」，pgvector 先前无条件发那条 DELETE ——
	 * 于是容量以下它会顺手收掉过期行并把条数报回来（另两个报 0），而每次 `put` 都在
	 * 热路径上白付一次删除。这条判据是那次分叉的锚：它不走 `put`，专挑「有过期行、
	 * 但没超容量」这个只有显式调用才看得见的状态。
	 */
	await s.clear();
	await s.put({ ...entry("过期未清理", "course:1", "h-y0", 31, 4_000), lastUsedAt: 4_999, useCount: 9 });
	await s.put({ ...entry("活着的", "course:1", "h-y1", 32, null), lastUsedAt: 1_000, useCount: 1 });
	out.push(`${policy}: 容量以下 evictOverCapacity 返回 ${await s.evictOverCapacity("course:1")}，剩 ${(await s.all()).length} 条`);

	await s.clear();
	return out;
}

const memory = await run(createMemoryCacheStore({ now }), now);
const real = await run(backing.store, now);
await backing.close();

/* 淘汰策略：每种策略各建一次库（配置在建库时定死，不能中途改） */
const POLICIES = ["fifo", "lru", "lfu", "rr"] as const;
for (const policy of POLICIES) {
	const cfg = { policy, capacity: 3 } as const;
	memory.push(...(await evictionRun(policy, createMemoryCacheStore({ now, eviction: cfg }))));
	const side = await createLabStore({ dimensions: { match: DIM }, now, eviction: cfg });
	real.push(...(await evictionRun(policy, side.store)));
	await side.close();
}

let bad = 0;
for (let i = 0; i < Math.max(memory.length, real.length); i++) {
	const same = memory[i] === real[i];
	if (!same) bad += 1;
	console.log(`${same ? "✓" : "✗"} ${memory[i] ?? "(内存无此项)"}`);
	if (!same) console.log(`   ${backing.kind}: ${real[i] ?? "(该后端无此项)"}`);
}
console.log(bad === 0 ? `\n${memory.length} 项全部一致。` : `\n${bad} 项不一致。`);
process.exit(bad === 0 ? 0 : 1);
