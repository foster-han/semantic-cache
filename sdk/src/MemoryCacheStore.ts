import { lfuCount } from "./EvictionOrder.ts";
import { assertFiniteVector, cosine } from "./VectorMath.ts";
import type { Candidate, CacheEntry, InspectableCacheStore } from "./types/CacheStore.ts";
import type { EvictionConfig } from "./types/Eviction.ts";

/**
 * 内存实现。用于单测、离线标定和本地验证台。
 *
 * 生产换成 `createPgVectorCacheStore` 即可，`SemanticCache` 不需要任何改动 ——
 * 判定逻辑与存储无关。两边的召回排序也逐位一致：pgvector 的 `1 - (v <=> q)`
 * 就是这里的 `cosine`。
 *
 * `all()` / `clear()` 是异步的，尽管内存里同步就能做完 —— 这样调用方从内存
 * 切到 pgvector 时不用改一遍 await。
 */
export function createMemoryCacheStore(options?: {
	now?: () => number;
	/** 容量淘汰。不给就不淘汰 —— 只靠 TTL 与显式失效 */
	eviction?: EvictionConfig;
}): InspectableCacheStore {
	const now = options?.now ?? (() => Date.now());
	const eviction = options?.eviction;
	let entries: Array<CacheEntry> = [];

	/**
	 * 淘汰时的**保留优先级**：排在前面的先保住，超出容量的从尾部删。
	 *
	 * 三种确定性策略都带 id 做次级键 —— 同毫秒写入、同使用次数时如果不定序，
	 * 「删哪一条」就成了实现细节，三种后端会给出不同答案。
	 *
	 * **`rr` 不走这个比较器**，它走 `sample()` 的均匀抽样。次数封顶与「没记过账
	 * 算一次」的理由都在 `EvictionOrder.ts` —— 三个后端必须用同一份。
	 *
	 * LFU 这里只解掉「新条目进不来」那一半；「用得多的老条目压着新条目」是 LFU
	 * 固有的，要衰减才治得了，这里没做。
	 */
	function keepOrder(a: CacheEntry, b: CacheEntry): number {
		switch (eviction?.policy) {
			case "lru": {
				const ua = a.lastUsedAt ?? a.createdAt;
				const ub = b.lastUsedAt ?? b.createdAt;
				return ub - ua || (a.id < b.id ? 1 : -1);
			}
			case "lfu": {
				const ca = lfuCount(a.useCount);
				const cb = lfuCount(b.useCount);
				if (ca !== cb) return cb - ca;
				// 次数相同时退到 LRU —— 纯 LFU 会让早期攒够次数的老条目永远赖着不走
				const ua = a.lastUsedAt ?? a.createdAt;
				const ub = b.lastUsedAt ?? b.createdAt;
				return ub - ua || (a.id < b.id ? 1 : -1);
			}
			default: // fifo：留最新的（rr 走 sample()，到不了这里）
				return b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);
		}
	}

	/**
	 * 从 `pool` 里均匀抽 `k` 条。
	 *
	 * **不能用 `sort(() => Math.random() - 0.5)`。** 那个比较器不自反也不传递，
	 * 不是均匀洗牌：`Array.prototype.sort` 在这种输入上的排列取决于它内部用的
	 * 归并/插入路径，明显偏向原顺序 —— 于是 `rr` 悄悄变成「偏向淘汰先写入的」，
	 * 跟 `fifo` 撞车，而它对外承诺的是随机。部分 Fisher–Yates 只洗前 k 个，O(k)。
	 */
	function sample(pool: ReadonlyArray<CacheEntry>, k: number): Array<CacheEntry> {
		const copy = [...pool];
		const out: Array<CacheEntry> = [];
		for (let i = 0; i < k && i < copy.length; i++) {
			const j = i + Math.floor(Math.random() * (copy.length - i));
			const swap = copy[i];
			copy[i] = copy[j];
			copy[j] = swap;
			out.push(copy[i]);
		}
		return out;
	}

	/**
	 * 把一个 scope 压回容量，返回删掉的条数。**`put` 与 `evictOverCapacity` 共用这一条** ——
	 * 先前两处逐字重复（pgvector 那边为同一件事已经合过一次）。
	 *
	 * **过期未清理的行先走，再按策略淘汰。** 容量数的是活条目：先前数的是数组里的
	 * 全部行，于是一条已过期、只是还没被 `purgeExpired` 收走的行会占着一个名额，
	 * 把一条活条目顶掉；而保留优先级根本不看过期，那条过期行只要 `lastUsedAt` 够新
	 * 就能接着顶掉好几条。pgvector 与 Redis 先前是同一个毛病，三处一起改。
	 *
	 * 只在超出容量时才扫过期 —— 容量边界以下零额外成本，而这条路本来就要排序。
	 */
	function trim(scope: string): number {
		const ev = eviction;
		if (!ev) return 0;
		const scoped = entries.filter(e => e.scope === scope);
		if (scoped.length <= ev.capacity) return 0;
		const t = now();
		const doomed = new Set(scoped.filter(e => e.expiresAt !== null && e.expiresAt <= t).map(e => e.id));
		const alive = scoped.filter(e => !doomed.has(e.id));
		const over = alive.length - ev.capacity;
		if (over > 0) {
			const victims = ev.policy === "rr" ? sample(alive, over) : [...alive].sort(keepOrder).slice(ev.capacity);
			for (const e of victims) doomed.add(e.id);
		}
		entries = entries.filter(e => !doomed.has(e.id));
		return doomed.size;
	}

	function live(): Array<CacheEntry> {
		const t = now();
		return entries.filter(e => e.expiresAt === null || e.expiresAt > t);
	}

	return {
		async getByHash(scope, matchHash) {
			// 取最新的那条。先前用的是 find()（取先插入的），和 pgvector 的
			// ORDER BY created_at DESC 正好相反 —— 一旦并发造出重复条目，
			// 换个存储后端 ② 命中的就是不同的答案。
			const matches = live().filter(e => e.scope === scope && e.matchHash === matchHash);
			if (matches.length === 0) return null;
			return matches.reduce((best, e) =>
				e.createdAt > best.createdAt || (e.createdAt === best.createdAt && e.id > best.id) ? e : best,
			);
		},
		async getById(id) {
			return live().find(e => e.id === id) ?? null;
		},
		async searchNearest(scope, vector, limit) {
			// 非有限分量三个后端一律抛（理由见 assertFiniteVector）—— 这里不抛就是 ③ 恒放行
			assertFiniteVector("查询向量", vector);
			const scoped = live().filter(e => e.scope === scope);
			const ranked: Array<Candidate> = scoped.map(entry => ({
				entry,
				similarity: cosine(vector, entry.matchVector),
			}));
			ranked.sort((a, b) => b.similarity - a.similarity);
			return ranked.slice(0, limit);
		},
		async put(entry) {
			// 接口要求 id 重复必须抛错。先前这里是无条件 push，于是同一个
			// id 碰撞 bug 在内存后端表现为"两条都在、后写的永远取不到"，
			// 在 pgvector 上表现为"后写的被静默丢弃" —— 同一个 bug 两种症状最难查。
			if (entries.some(e => e.id === entry.id)) {
				throw new Error(`缓存条目 id 重复：${entry.id}。id 由库生成，重复只可能是生成器碰撞。`);
			}
			// pgvector 在 toVectorLiteral 里、Redis 在 vectorArgs 里查同一件事
			assertFiniteVector("matchVector ", entry.matchVector);
			entries.push(entry);
			trim(entry.scope);
		},
		async evict(id) {
			entries = entries.filter(e => e.id !== id);
		},
		async evictBySource(sourceId) {
			const before = entries.length;
			entries = entries.filter(e => !e.sourceIds.includes(sourceId));
			return before - entries.length;
		},
		async touch(id) {
			// fifo/rr 不需要记账 —— 真正的空操作，连查找都不做
			if (eviction?.policy !== "lru" && eviction?.policy !== "lfu") return;
			const i = entries.findIndex(e => e.id === id);
			if (i < 0) return; // 可能刚被并发驱逐，静默返回
			const e = entries[i];

			// 基数是 1，不是 0 —— 保留优先级把「没记过账」也算 1（写入即一次使用），
			// 从 0 起加会让第一次复用完全不提升优先级，阶梯断一级
			entries[i] = { ...e, lastUsedAt: now(), useCount: (e.useCount ?? 1) + 1 };
		},

		async evictOverCapacity(scope) {
			return trim(scope);
		},

		async purgeExpired() {
			const t = now();
			const before = entries.length;
			entries = entries.filter(e => e.expiresAt === null || e.expiresAt > t);
			return before - entries.length;
		},
		async clearScope(scope) {
			const before = entries.length;
			entries = entries.filter(e => e.scope !== scope);
			return before - entries.length;
		},
		async all() {
			// 返回副本：直接给出内部数组的话，调用方手里的引用会随后续写入变化。
			// 排序是契约要求的（createdAt 升序，同毫秒按 id）—— 插入顺序只在
			// 「条目恰好按时间写入」时与它一致，那种巧合掩盖过一次真库与内存的分叉。
			return [...entries].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		},
		async clear() {
			entries = [];
		},
	};
}
