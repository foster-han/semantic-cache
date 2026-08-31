import { cosine } from "./VectorMath.ts";
import type { Candidate, CacheEntry, InspectableCacheStore } from "./types/CacheStore.ts";

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
export function createMemoryCacheStore(options?: { now?: () => number }): InspectableCacheStore {
	const now = options?.now ?? (() => Date.now());
	let entries: Array<CacheEntry> = [];

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
			entries.push(entry);
		},
		async evict(id) {
			entries = entries.filter(e => e.id !== id);
		},
		async evictBySource(sourceId) {
			const before = entries.length;
			entries = entries.filter(e => !e.sourceIds.includes(sourceId));
			return before - entries.length;
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
			// 返回副本：直接给出内部数组的话，调用方手里的引用会随后续写入变化
			return [...entries];
		},
		async clear() {
			entries = [];
		},
	};
}
