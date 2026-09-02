import type { CachePolicy, CacheDisposition } from "./types/CachePolicy.ts";
import type { CachePrompt } from "./types/Pipeline.ts";

/**
 * 只用**结构信号**的默认策略。
 *
 * 结构信号 = agent 规划阶段已经算出来的那几个布尔量：这轮要不要调工具、
 * 需不需要把对话历史拼进 prompt、任务是解释还是生成。它们比任何词表或分类器都准，
 * 而且已经在调用方手里 —— 这一层只负责把它们从 `prompt.context` 读出来，不做文本判断。
 *
 * **刻意不内置任何关键词。**「现在/今天/最新」这类词表看着省事，实际是最脆的一档：
 * 漏一个就是持续的错答案，而且中英文各要维护一份。要用词表或分类器，自己写一个
 * `CachePolicy` 传进去，或者用 `combinePolicies` 串在这个后面。
 */

/** `context` 里值为这些时视为「没有这个信号」。其余任何值都算设置了。 */
const FALSY = new Set(["", "0", "false", "no", "off"]);

function isSet(context: Readonly<Record<string, string>>, key: string): boolean {
	const raw = context[key];
	return raw !== undefined && !FALSY.has(raw.trim().toLowerCase());
}

/**
 * 默认允许走**语义**缓存的调用类型。
 *
 * 判据只有一条：**输出是不是输入的确定函数。**
 *
 * - `completion` / `responses` / `anthropic_messages` —— 有采样，同输入不同输出。
 *   「相似的问题能不能复用答案」才是个真问题，才需要这五道闸。**在列。**
 * - `embedding` —— 同文本必然同向量。拿相似度去匹配它，等于用「差不多的文本」
 *   换一个「差不多的向量」，正好摧毁向量本身的意义。**该走精确缓存（内容哈希）。**
 * - `rerank` —— 同 query + 同文档集必然同分数。同上。
 * - `transcription` —— 同文件必然同转写。两段「相似」的音频不是同一段音频。
 * - `text_completion` —— 老式接口，且 litellm 那边它本来就提不出 prompt。
 *
 * **被排除不等于不该缓存**，恰恰相反：后四类走精确缓存是零假命中风险、
 * 命中即赚的一档，应该先吃满。它们只是不该走**这一层**。
 *
 * 异步变体（`a` 前缀）不必单独列，匹配时会处理。
 */
export const DEFAULT_SEMANTIC_CALL_TYPES: ReadonlyArray<string> = ["completion", "responses", "anthropic_messages"];

/**
 * 调用类型匹配。**不能无脑剥 `a` 前缀** —— `anthropic_messages` 自己就以 a 开头，
 * 剥掉会变成 `nthropic_messages` 而漏判。所以先查原名，再查去掉前缀的名字：
 * `anthropic_messages` 走第一条，`aanthropic_messages` 走第二条。
 */
function isAllowedCallType(callType: string, allowed: ReadonlySet<string>): boolean {
	if (allowed.has(callType)) return true;
	return callType.startsWith("a") && allowed.has(callType.slice(1));
}

export interface StructuralPolicyOptions {
	/**
	 * `context` 键 → 理由。命中就**不读**缓存（`no-cache`），但照常写回。
	 *
	 * 「重新回答」走这里：跳过查询强制重生成，新答案替换掉旧的那条。
	 */
	readonly noCacheWhen?: Readonly<Record<string, string>>;
	/**
	 * `context` 键 → 理由。命中就**不写**缓存（`no-store`），但照常读。
	 *
	 * 「出五道练习题」走这里：别人问过就用别人的，但别把我这份存成标准答案。
	 */
	readonly noStoreWhen?: Readonly<Record<string, string>>;
	/**
	 * `context` 键 → 理由。两个都设 —— 既不读也不写，最常用的那一档。
	 *
	 * **键名由调用方定**，这里不预设 `needsHistory` 之类的魔法字符串 ——
	 * 那种约定在跨仓库时一定会拼错，而拼错的后果是策略静默失效。
	 */
	readonly bypassWhen?: Readonly<Record<string, string>>;
	/** `context` 键 → 这一条的 TTL（毫秒）。多个键同时命中取**最短**的那个 */
	readonly shortTtlWhen?: Readonly<Record<string, number>>;
	/**
	 * 从 `context` 的哪个键读「这次是什么调用」。默认 `"callType"`。
	 *
	 * 值用 litellm 的那套名字（`completion` / `embedding` / `rerank` /
	 * `transcription` / `responses` / `anthropic_messages` / `text_completion`，
	 * 含 `a` 前缀的异步变体），这样网关和这里说的是同一种话。
	 */
	readonly callTypeKey?: string;
	/**
	 * 允许走语义缓存的调用类型白名单。默认 {@link DEFAULT_SEMANTIC_CALL_TYPES}。
	 *
	 * 不在列的直接 `noCache` + `noStore`。**白名单而不是黑名单**：漏配一个新出现的
	 * 调用类型，后果是「这类没走语义缓存」（少一次命中，便宜），而不是「一类不该
	 * 语义匹配的东西被语义匹配了」（错答案，贵）。
	 */
	readonly allowedCallTypes?: ReadonlyArray<string>;
	/**
	 * 没标 `callTypeKey` 时怎么办。默认 `false` = 放行。
	 *
	 * 放行是因为这个库的入口只有 `resolve(prompt, generate)`，本来就只处理 chat 形态 ——
	 * 没标的请求几乎必然就是它。但如果你把多种调用都路由到这一层，**打开它**：
	 * 那时「忘了标」和「标成 embedding」的后果完全不同，前者会静默走完语义匹配。
	 */
	readonly requireCallType?: boolean;
}

export function createStructuralPolicy(options: StructuralPolicyOptions = {}): CachePolicy {
	const noCacheWhen = options.noCacheWhen ?? {};
	const noStoreWhen = options.noStoreWhen ?? {};
	const bypassWhen = options.bypassWhen ?? {};
	const shortTtlWhen = options.shortTtlWhen ?? {};

	for (const [key, ttl] of Object.entries(shortTtlWhen)) {
		if (!Number.isFinite(ttl) || ttl <= 0) {
			throw new Error(`shortTtlWhen["${key}"]=${ttl} 不是正的毫秒数。想让它永不过期请用 ttlMs: null，想让它不进缓存请用 noStoreWhen。`);
		}
	}
	/**
	 * 四张表的键必须互不相交。
	 *
	 * 同一个键出现在两张表里，哪张赢只能靠读源码 —— 而这一层的全部意义就是
	 * 让「为什么这条没缓存」有个明确答案。直接拒绝，比定一个优先级好。
	 */
	const seen = new Map<string, string>();
	for (const [table, keys] of [
		["noCacheWhen", Object.keys(noCacheWhen)],
		["noStoreWhen", Object.keys(noStoreWhen)],
		["bypassWhen", Object.keys(bypassWhen)],
		["shortTtlWhen", Object.keys(shortTtlWhen)],
	] as ReadonlyArray<[string, ReadonlyArray<string>]>) {
		for (const key of keys) {
			const previous = seen.get(key);
			if (previous !== undefined) {
				throw new Error(`context 键 "${key}" 同时出现在 ${previous} 和 ${table} 里。哪个生效只能靠读源码，所以直接拒绝 —— 换个键名，或者合并成一条。`);
			}
			seen.set(key, table);
		}
	}

	const callTypeKey = options.callTypeKey ?? "callType";
	const allowedCallTypes = new Set(options.allowedCallTypes ?? DEFAULT_SEMANTIC_CALL_TYPES);
	const requireCallType = options.requireCallType ?? false;
	if (allowedCallTypes.size === 0) {
		throw new Error("allowedCallTypes 是空的 —— 那等于关掉整个缓存。真想全关就别装这个策略，别用一个空白名单表达它。");
	}

	return function structuralPolicy(prompt: CachePrompt): CacheDisposition {
		let noCache: string | undefined;
		let noStore: string | undefined;

		const callType = prompt.context[callTypeKey]?.trim();
		if (callType === undefined || callType === "") {
			if (requireCallType) {
				const reason = `没有标注调用类型（context.${callTypeKey}）—— requireCallType 打开时不放行未标注的请求`;
				noCache = reason;
				noStore = reason;
			}
		} else if (!isAllowedCallType(callType, allowedCallTypes)) {
			const reason = `调用类型 "${callType}" 不在语义缓存白名单里 —— 它的输出是输入的确定函数，该走精确缓存而不是相似度匹配`;
			noCache = reason;
			noStore = reason;
		}
		for (const [key, reason] of Object.entries(bypassWhen)) {
			if (isSet(prompt.context, key)) {
				noCache ??= reason;
				noStore ??= reason;
			}
		}
		for (const [key, reason] of Object.entries(noCacheWhen)) {
			if (isSet(prompt.context, key)) noCache ??= reason;
		}
		for (const [key, reason] of Object.entries(noStoreWhen)) {
			if (isSet(prompt.context, key)) noStore ??= reason;
		}
		let ttlMs: number | undefined;
		for (const [key, ttl] of Object.entries(shortTtlWhen)) {
			if (isSet(prompt.context, key)) ttlMs = ttlMs === undefined ? ttl : Math.min(ttlMs, ttl);
		}
		const disposition: { noCache?: string; noStore?: string; ttlMs?: number } = {};
		if (noCache !== undefined) disposition.noCache = noCache;
		if (noStore !== undefined) disposition.noStore = noStore;
		if (ttlMs !== undefined) disposition.ttlMs = ttlMs;
		return disposition;
	};
}

/**
 * 按顺序试。`noCache` / `noStore` **各自独立**取第一个说不的理由，TTL 取最短。
 *
 * 两个开关分开合并，是因为它们本来就正交：一个策略说「这条别写」、另一个说
 * 「这条别读」，合起来应该是两条都生效，而不是谁覆盖谁。TTL 取最短而不是取
 * 最后一个 —— 两个策略各自认为「最多活十分钟」和「最多活一天」时，
 * 唯一安全的合并是十分钟。
 */
export function combinePolicies(...policies: ReadonlyArray<CachePolicy>): CachePolicy {
	if (policies.length === 0) throw new Error("combinePolicies 至少要一个策略 —— 零个策略等于没有策略，不如别传。");
	return async function combined(prompt: CachePrompt): Promise<CacheDisposition> {
		let noCache: string | undefined;
		let noStore: string | undefined;
		let ttlMs: number | null | undefined;
		for (const policy of policies) {
			const decision = await policy(prompt);
			noCache ??= decision.noCache;
			noStore ??= decision.noStore;
			if (decision.ttlMs === undefined) continue;
			// null = 永不过期，是最松的一档，不该覆盖任何有限值
			if (decision.ttlMs === null) ttlMs = ttlMs === undefined ? null : ttlMs;
			else ttlMs = typeof ttlMs === "number" ? Math.min(ttlMs, decision.ttlMs) : decision.ttlMs;
		}
		const disposition: { noCache?: string; noStore?: string; ttlMs?: number | null } = {};
		if (noCache !== undefined) disposition.noCache = noCache;
		if (noStore !== undefined) disposition.noStore = noStore;
		if (ttlMs !== undefined) disposition.ttlMs = ttlMs;
		return disposition;
	};
}
