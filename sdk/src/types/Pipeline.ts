import type { Chunk } from "./Retrieval.ts";

/**
 * 一次提问。
 *
 * 叫 prompt 不叫 request：它是 RedisVL `store(prompt, …)` / LangChain
 * `lookup(prompt, …)` 里的那个 prompt，跟 HTTP 请求没有关系 —— 这个仓库里
 * `req` 已经是 lab/Server.ts 的 http 请求了，两个概念不该共用一个词。
 * 之所以不退化成一个字符串，是因为除了问题文本，还得带上 `redacted`
 * （守卫要用）和 `context`（ScopeResolver 判隔离边界要用）。
 *
 * **`matchText` 和 `retrievalText` 是两个字段，这是有意的。**
 * 上游做了 PII 匿名化时，缓存键必须建在匿名化后的文本上（`matchText`），
 * 而检索必须用保留实体的原文（`retrievalText`）—— 否则回答侧校验拦不住
 * 占位符塌陷。没有匿名化的应用把两者传成同一个字符串即可。
 */
export interface CachePrompt {
	readonly matchText: string;
	readonly retrievalText: string;
	/**
	 * 上层是否对 `matchText` 做过脱敏（实体被占位符替换）。
	 *
	 * 置为 true 时，SDK **拒绝**把这条请求落进共享 scope。原因是脱敏之后
	 * 两个不同的人可能塌成同一个缓存键，而答案里带着占位符 —— 跨用户复用时
	 * 用当前请求的实体映射去还原，就会把甲的答案还原成乙的名字。
	 * 这不是概率问题，是构造上必然的错误，所以在类型与运行期都堵死。
	 */
	readonly redacted?: boolean;
	/** 传给 Retriever 与 ScopeResolver 的上下文，如 courseId、unit、userId */
	readonly context: Readonly<Record<string, string>>;
}

/**
 * scope 决策。返回字符串即视为**共享** scope（保守默认）。
 * 要声明这是个只属于单个主体的隔离 scope，返回 `{ key, shared: false }`。
 *
 * PII 过滤留在 SDK 之上：库不认识 PII，只认这里返回的隔离边界。
 */
export type ScopeDecision = string | { readonly key: string; readonly shared: boolean };
export type ScopeResolver = (prompt: CachePrompt) => Promise<ScopeDecision> | ScopeDecision;

export type GateId = 1 | 2 | 3 | 4 | 5 | 6;

export type GateVerdict =
	| "pass"
	| "hit"
	| "miss"
	| "exit"
	/** 这道闸本会拦下，但被配置关掉了 —— 用于 A/B 时看清代价 */
	| "would-exit"
	| "off";

export interface GateTrace {
	readonly gate: GateId;
	readonly name: string;
	readonly verdict: GateVerdict;
	readonly detail: string;
	readonly score?: number;
}

export type Outcome =
	/** 精确命中并通过全部校验 */
	| "exact"
	/** 语义命中并通过全部校验 */
	| "reuse"
	/** 命中但支撑度只到中带，用旧答案 + 新片段做了一次短生成 */
	| "refine"
	/** 未命中或被某道闸拦下，走了完整生成 */
	| "generated";

export interface CacheResult {
	/**
	 * 命中或新生成的载荷。**只有这一个读取入口。**
	 *
	 * 早先这里还并排放过一个 `answer: string`，plan 时为空串 —— 读 `.answer`
	 * 会静默拿到空串而不报错，正是这套 API 一路在消灭的那种失效。删掉了，
	 * 调用方必须 `switch (payload.kind)`。
	 */
	readonly payload: CachedPayload;
	readonly outcome: Outcome;
	/** 被哪道闸拦下；未被拦下时为 null */
	readonly exitedAt: GateId | null;
	/**
	 * 这次结果对应的条目 id —— **永远指向存储里现存的那一条**。
	 *
	 * `generated` 时是刚写进去的那条；`refine` 时是替换后的新条目（旧的已经删了，
	 * 返回旧 id 的话调用方拿它去 `get()` 只会拿到 null）。
	 */
	readonly entryId: string | null;
	readonly sourceIds: ReadonlyArray<string>;
	readonly trace: ReadonlyArray<GateTrace>;
}

/** 调用方自己的生成。库决定要不要调它，并把已检索的片段递进来避免重复检索。 */
export type Generate = (prompt: CachePrompt, chunks: ReadonlyArray<Chunk>) => Promise<CachedPayload>;

/**
 * 缓存里存的是什么 —— 这个区分决定了哪些闸适用，也决定了脱敏后能不能跨主体共享。
 *
 * **answer**：文本答案，含实体特定内容。依赖语料，所以要过 ⑤ 版本比对和
 * ⑥ 回答校验；脱敏后**不能**跨主体共享，否则甲的答案会被安上乙的名字。
 *
 * **plan**：工具调用计划，实体是**参数**而不是内容。不依赖语料（⑤ 不适用），
 * 没有实体特定内容（⑥ 不适用），执行时用当前请求的实体填参、当场做授权检查。
 * 脱敏后跨主体共享**正是所求** —— 一个模板服务所有人，塌得越彻底缓存效率越高。
 *
 * 贵的是 LLM 判断"该调哪个工具、传什么参数"，工具调用本身很便宜，
 * 所以这一支缓存计划、不缓存结果；结果每次实时取。
 */
export type CachedPayload =
	| {
			readonly kind: "answer";
			readonly answer: string;
			/**
			 * 据以生成的资料，顺序即重要性。
			 *
			 * **空数组的 answer 条目 ⑤ 和 `invalidateSource` 都够不着**：版本指纹恒为
			 * 空串所以永远"一致"，而按资料 id 的批量失效匹配不到空数组。⑥ 仍然照常
			 * 保护它。真正的问题在更前面 —— 一个没有任何检索依据的 RAG 答案，
			 * 要么是拒答要么是幻觉，该不该进缓存值得先想清楚。
			 */
			readonly sourceIds: ReadonlyArray<string>;
	  }
	| {
			readonly kind: "plan";
			/** 工具名与参数。参数值用字符串；更复杂的计划请由调用方自行序列化。 */
			readonly plan: Readonly<Record<string, string>>;
	  };

/**
 * @deprecated 用 `CachedPayload`。保留以免旧代码断裂。
 *
 * 先前这个接口在本文件里声明了**两次**（第二次多了一行字段注释）。两次的成员恰好
 * 一致，于是 interface merging 让它合法通过了类型检查 —— 改动其中一份才会炸，
 * 而那时看到的报错是「同名声明不一致」，不是「这里有两份」。合成一份。
 */
export interface GeneratedAnswer {
	readonly answer: string;
	/** 实际据以生成的资料，顺序即重要性 */
	readonly sourceIds: ReadonlyArray<string>;
}

/** 旧答案 + 新片段的短生成。不提供时中带退化为完整生成。 */
export type Refine = (
	cachedAnswer: string,
	prompt: CachePrompt,
	chunks: ReadonlyArray<Chunk>,
) => Promise<CachedPayload>;

/**
 * 闸门开关。
 *
 * **④ 精排不在这里** —— 它由 `RerankStage` 提供与否决定。开关和阈值分家，
 * 正是尺度混用的温床：关掉开关却留着阈值，那个阈值就会被套到另一个尺度上。
 */
export interface GateSwitches {
	/** ⑤ 资料版本比对 */
	readonly sourceVersion: boolean;
	/** ⑥ 回答有效性校验 */
	readonly answerCheck: boolean;
}

/**
 * 一次写入需要的、与请求无关的派生信息。
 *
 * `lookup()` 已经把 scope 解过一遍、哈希算过一遍、（多数路径上）向量也编过一遍。
 * 把它们带出来交给 `write()`，调用方在「未命中 → 自己生成 → 写回」这条最常见的
 * 手工路径上就不用重付一次 embedding。
 *
 * **票据省的只有 embedding。** scope 和哈希 `write()` 每次都重算，然后跟票据核对 ——
 * 那两样本来就便宜（一次字符串哈希、一次通常是纯函数的 ScopeResolver 调用），
 * 而拿 A 问题的票据去写 B 问题的答案，后果是一条永远读不回来、甚至落错 scope
 * 的缓存。省那两次调用换不来这个风险。
 */
export interface WriteTicket {
	readonly scope: string;
	/** scope 是否共享 —— 脱敏守卫要用 */
	readonly shared: boolean;
	readonly matchHash: string;
	/** PairEncoder 空间 */
	readonly matchVector: ReadonlyArray<number>;
}

export type LookupOutcome =
	/** 精确命中且过了全部校验 */
	| "exact"
	/** 语义命中且过了全部校验 */
	| "reuse"
	/** 命中，但支撑度只到中带 —— 旧答案还在，用不用由调用方决定 */
	| "mid"
	/** 没有可用条目 */
	| "miss";

/**
 * 只读匹配的结果。
 *
 * **`lookup` 不生成、也不写入新条目**，但它会驱逐被 ⑤⑥ 判定为失效的旧条目 ——
 * 那是维护，不是写入：一条版本已过期或已不被语料支撑的缓存，读到它的那一刻就
 * 该消失，留着只会让下一个请求再判一次。
 */
export interface LookupResult {
	readonly outcome: LookupOutcome;
	/** 命中时的载荷；miss 时为 null */
	readonly payload: CachedPayload | null;
	readonly entryId: string | null;
	readonly sourceIds: ReadonlyArray<string>;
	/** 被哪道闸拦下；命中时为 null */
	readonly exitedAt: GateId | null;
	readonly trace: ReadonlyArray<GateTrace>;
	/**
	 * ⑥ 已经检索过的片段。**没走到 ⑥ 时是 null** —— 那时调用方要自己检索。
	 * 走到过就直接用，别再检索一遍。
	 */
	readonly chunks: ReadonlyArray<Chunk> | null;
	/** ⑥ 的支撑度；没算到时为 null */
	readonly support: number | null;
	/**
	 * 取写入票据。**是个函数而不是字段**：② 精确命中那条路径本来不需要召回向量，
	 * 为了填一个多半用不上的字段去付一次模型调用，正好毁掉那一层的全部价值。
	 * 结果记忆化，调几次都只算一次。
	 */
	prepareWrite(): Promise<WriteTicket>;
}

/** 写入时的可选项。三项都不给就是「用 lookup 的票据、无 meta、走全局 TTL」。 */
export interface WriteOptions {
	/**
	 * `lookup()` 那次已经解好的 scope / 哈希 / 向量。不传就现算 ——
	 * 代价是多一次 scope 解析和一次 embedding。
	 */
	readonly ticket?: WriteTicket;
	/** 调用方自己的记账字段（模型名、请求 id、成本…）。库不解释它的内容 */
	readonly meta?: Readonly<Record<string, string>>;
	/**
	 * 这一条的存活时长，覆盖全局 `ttlMs`。`null` = 不过期。
	 *
	 * 有per-entry TTL 才谈得上「课务问答缓一天、时效性内容缓十分钟」——
	 * 全局一个值的话，最短的那类需求会把所有条目的 TTL 一起拉下来。
	 */
	readonly ttlMs?: number | null;
	/**
	 * 写入成功后要驱逐的旧条目 id —— 用于「替换」而不是「新增」。
	 *
	 * 顺序是**先写后删**：窗口里存在的是两条而不是零条。宁可让并发读者看到一条
	 * 稍旧的，也不要让它看到未命中然后又生成一条；写失败时旧条目还在。
	 */
	readonly supersedes?: string;
}

/** 批量写入的一项。 */
export interface WriteItem {
	readonly prompt: CachePrompt;
	readonly payload: CachedPayload;
	readonly options?: WriteOptions;
}
