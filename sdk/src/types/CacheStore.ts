/** 一条缓存记录。向量一律由库来算，调用方不传向量，避免向量空间被混用。 */
export interface CacheEntry {
	readonly id: string;
	readonly scope: string;
	/** 用于精确匹配与召回的文本（若上游做了匿名化，这里是匿名化之后的） */
	readonly matchText: string;
	readonly matchHash: string;
	/** PairEncoder 空间 */
	readonly matchVector: ReadonlyArray<number>;
	/** 缓存的是文本答案还是工具计划 —— 决定 ⑤ 是否适用 */
	readonly kind: "answer" | "plan";
	/** kind === "plan" 时为空串 */
	readonly answer: string;
	/** kind === "plan" 时为空对象 */
	readonly plan: Readonly<Record<string, string>>;
	/** 生成这条答案时引用的资料 id，顺序即重要性，[0] 是首要依据。plan 条目为空 */
	readonly sourceIds: ReadonlyArray<string>;
	/** 写入时这些资料的版本指纹。plan 条目为空串 */
	readonly sourceVersion: string;
	readonly createdAt: number;
	readonly expiresAt: number | null;
	readonly meta?: Readonly<Record<string, string>>;
	/**
	 * 最近一次被复用的时间。`lru` 淘汰用，其他策略下恒为 undefined。
	 *
	 * 写入时不设 —— 那时它等于 `createdAt`，多存一遍没有信息。排序时用
	 * `lastUsedAt ?? createdAt`。
	 */
	readonly lastUsedAt?: number;
	/** 被复用过几次。`lfu` 淘汰用，其他策略下恒为 undefined */
	readonly useCount?: number;
}

export interface Candidate {
	readonly entry: CacheEntry;
	/** PairEncoder 空间的余弦 */
	readonly similarity: number;
}

/**
 * 存储接口。内存实现用于测试与标定，生产实现打 pgvector。
 *
 * `searchNearest` 必须在库内做 pre-filter：只返回同一个 scope、且未过期的条目。
 * 过期行即使还没被清理也绝不能返回。
 *
 * 自己实现时另有三条硬要求（见 DESIGN.md）：`put` 遇 id 重复必须抛、`getByHash`
 * 必须确定性取最新那条、向量里的非有限分量必须抛（用 `assertFiniteVector`，
 * 静默落 0 或原样存下会让 ③ 的召回下限形同不存在）。
 */
export interface CacheStore {
	/**
	 * 按归一化哈希取候选。
	 *
	 * **实现方只需按哈希查；原文的最终比对由 SemanticCache 负责。**
	 * `matchHash` 是非密码学哈希，碰撞会让「精确匹配」返回一条完全无关的答案 ——
	 * 而这一层的全部价值就在于零假命中风险。所以库拿到候选后一定会再比一次
	 * `matchText`，不依赖任何存储实现自觉做这件事。
	 */
	/**
	 * 按 scope + 归一化哈希取候选。
	 *
	 * **同一个 (scope, matchHash) 下有多条时，返回最新的那条**（`createdAt` 最大，
	 * 同毫秒则 id 最大）。并发写入会造出这种重复，而"取哪一条"必须是确定的：
	 * 两个存储实现在这里给出不同答案的话，② 命中的就是不同的答案。
	 */
	getByHash(scope: string, matchHash: string): Promise<CacheEntry | null>;
	/**
	 * 按 id 取。和 `getByHash` 一样**只返回未过期的条目** —— 它是读路径的一部分
	 * （调用方拿着上一次的 entryId 回来取），不是诊断入口；要看已过期未清理的
	 * 原始状态用 `InspectableCacheStore.all()`。
	 */
	getById(id: string): Promise<CacheEntry | null>;
	searchNearest(scope: string, vector: ReadonlyArray<number>, limit: number): Promise<Array<Candidate>>;
	/**
	 * 写入一条。**id 重复必须抛错，不能静默丢弃、更不能覆盖。**
	 *
	 * 这个设计里 `put` 从来不是 upsert：id 由库生成，没有任何合法路径会用同一个 id
	 * 写两次。所以 id 冲突永远是 bug（多半是 id 生成器跨进程碰撞）——静默丢弃会让
	 * 一条缓存凭空消失，覆盖则会让一个进程改写另一个进程内容完全不同的条目。
	 */
	put(entry: CacheEntry): Promise<void>;
	evict(id: string): Promise<void>;
	/** 语料改版时按资料 id 批量失效 —— 这是 ⑤ 的批量对应操作 */
	evictBySource(sourceId: string): Promise<number>;
	/**
	 * 清空一个 scope，返回删掉的条数。
	 *
	 * 它在热路径的契约里而 `clear()` 不在，是因为**这一个是生产操作**：课程归档、
	 * 老师要求重置、租户注销，都要按 scope 清。无参数的全清才是测试专属。
	 */
	clearScope(scope: string): Promise<number>;
	/**
	 * 删除已过期的行，返回删掉的条数。
	 *
	 * 读路径本来就把过期条目挡在外面，所以这个方法**不影响正确性，只管存储占用**：
	 * 不调的话过期行永远留在表里，pgvector 那边还会拖慢 scope 内的精确 KNN 扫描。
	 * 挂个定时任务调它即可。
	 */
	purgeExpired(): Promise<number>;
	/**
	 * 命中时记账。**`fifo`/`rr` 下必须是真正的空操作**（不发请求、不写盘）——
	 * 那两种策略不需要读路径写入，而调用方会无条件调它，策略知识留在存储里。
	 *
	 * `lru` 更新 `lastUsedAt`，`lfu` 自增 `useCount`。条目不存在时静默返回：
	 * 它可能刚被并发驱逐，为一次记账失败让整个命中路径抛错不值得。
	 */
	touch(id: string): Promise<void>;
	/**
	 * 把一个 scope 压回容量上限，返回删掉的条数。没配 `eviction` 时返回 0。
	 *
	 * 由存储在 `put` 之后自己调，所以调用方通常不用碰它；单独暴露是为了能测，
	 * 也为了让运维能对某个 scope 手动收一次。
	 */
	evictOverCapacity(scope: string): Promise<number>;
}

/**
 * 带内省能力的存储 —— 测试、离线标定和验证台需要「清空」和「列出全部」，
 * 生产读路径不需要。所以它们不在 `CacheStore` 里：那是热路径的契约，
 * 让每个生产实现都去实现一个只有测试会调的 `all()` 是白白加负担。
 *
 * 两个方法都是异步的。内存实现同步就能做完，但真库不行，
 * 而调用方不该因为换了存储实现就得改一遍 await。
 */
export interface InspectableCacheStore extends CacheStore {
	/** 清空。生产不该调 */
	clear(): Promise<void>;
	/**
	 * 列出全部条目，**含已过期但尚未清理的** —— 供 UI 展示与断言检查。
	 *
	 * **顺序是契约的一部分：按 `createdAt` 升序，同毫秒按 `id` 升序。**
	 * 两个真库实现本来就得给个 ORDER BY（否则分页和「最近 N 条」都没有意义），
	 * 而内存实现先前返回的是插入顺序 —— 两者在条目按时间顺序写入时恰好一致，
	 * 于是这处分叉一直看不见，直到一致性脚本里出现一条 createdAt 更早、
	 * 却最后写入的条目。
	 */
	all(): Promise<ReadonlyArray<CacheEntry>>;
}
