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
 * scope 决策。三个字段都必填 —— 没有「返回一个字符串就算共享 scope」这种简写，
 * 那会让 `org` 与 `shared` 变成可以忘掉的东西，而它们各自的失效都是静默的。
 *
 * PII 过滤留在 SDK 之上：库不认识 PII，只认这里返回的隔离边界。
 */
export interface ScopeDecision {
	/** 业务隔离边界,比如某门课、某个知识库 */
	readonly key: string;
	readonly shared: boolean;
	/**
	 * 组织 / 租户 id。**必填,而且不能靠拼进 `key` 来代替。**
	 *
	 * ③ 是 scope **内**的向量召回 —— 问题文本不在 key 里,分桶就只靠这个字符串。
	 * 拼错的后果不是少一次命中,是**跨租户返回别人的答案**,而且完全静默。
	 * 库用 `composeScope()` 转义后拼接,所以 `("a", "b|c")` 和 `("a|b", "c")`
	 * 落在不同的桶里 —— 自己拼字符串挡不住这一类。
	 *
	 * 单租户部署也要给一个固定值(比如 `"default"`),让它是个显式的决定。
	 */
	readonly org: string;
}
/**
 * 判这一次提问属于哪个隔离边界。
 *
 * **必须是 `prompt` 的纯函数。**决策只能来自参数（`context` 就是为此存在的），
 * 不能从请求外的环境里读 —— AsyncLocalStorage 里的租户、请求头、模块级的
 * 「当前用户」都不行。库把解析出来的 scope 放进了进程内合流键，所以一个不纯的
 * resolver 会让两个租户的同一句话合流，后到的租户拿到前一个租户的答案。
 * 需要租户信息就把它放进 `prompt.context`，让它成为请求的一部分。
 */
export type ScopeResolver = (prompt: CachePrompt) => Promise<ScopeDecision> | ScopeDecision;

export type GateId = 1 | 2 | 3 | 4 | 5;

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
	/**
	 * 这一步**真的删掉了一条条目**。
	 *
	 * **驱逐必须由这个字段声明，不能从 `verdict === "exit"` 反推。** 有一半的
	 * `exit` 什么都没删：无资料依据的答案不写入也不删，影子模式下 ⑤ 判负也不删。
	 *
	 * 反推的话，一次上游故障会让看板报出「N 次判负驱逐」而缓存一条没动 ——
	 * 「一次故障不改变缓存状态」这条不变量会被指标自己打穿，而且是从最可信的那一侧
	 * （看板）打穿。`Metrics.ts` 因此只认这个字段。
	 */
	readonly evicted?: boolean;
}

export type Outcome =
	/** 精确命中并通过全部校验 */
	| "exact"
	/** 语义命中并通过全部校验 */
	| "reuse"
	/** 未命中或被某道闸拦下，走了完整生成 */
	| "generated"
	/**
	 * `CachePolicy` 的 `noCache` 生效 —— **有意没查缓存**，直接生成。
	 *
	 * 不并进 `generated`：那样一次「策略绕开」和一次「查了但没命中」在看板上
	 * 完全一样，于是「上游某个信号一直是开的」这种事只表现为命中率下降，
	 * 查不出原因。这正是 litellm 那类框架里静默 no-op 的病根。
	 */
	| "bypassed";

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
	/**
	 * `outcome === "bypassed"` 时是 `noCache` 的理由，其余为 null。
	 *
	 * 指标要按理由分组才有诊断价值：只知道「绕开变多了」查不出是哪条规则，
	 * 而上游某个信号一直是开的，恰恰是这类系统最常见的静默失效。
	 */
	readonly bypassReason: string | null;
	/**
	 * 影子模式下这一次**本来会不会复用**；非影子模式为 null。
	 *
	 * 指标层靠它算「本会命中率」—— 那是决定要不要真开缓存的那个数。
	 */
	readonly wouldReuse: boolean | null;
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
 * **answer**：文本答案，含实体特定内容。依赖语料，所以要过 ⑤ 版本比对；
 * 脱敏后**不能**跨主体共享，否则甲的答案会被安上乙的名字。
 *
 * **plan**：工具调用计划，实体是**参数**而不是内容。不依赖语料（⑤ 不适用），
 * 执行时用当前请求的实体填参、当场做授权检查。
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
			 * 空串所以永远"一致"，而按资料 id 的批量失效匹配不到空数组。移除 ⑥ 之后
			 * 它连答案侧的兜底也没有了 —— 所以 `cacheable()` 直接拒绝写入这种条目，
			 * 那道守卫从「多一层保险」变成了唯一一层。
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

/**
 * 闸门开关。
 *
 * **④ 精排不在这里** —— 它由 `RerankStage` 提供与否决定。开关和阈值分家，
 * 正是尺度混用的温床：关掉开关却留着阈值，那个阈值就会被套到另一个尺度上。
 *
 * 先前这里还有 ⑥ 回答有效性校验的开关。⑥ 已移除 —— 它对应的两类失效
 * （同词不同指、实体塌陷）源于缓存键有损，而那该由键的设计和读侧条件解决，
 * 不该由一道在答案侧兜底的闸解决。
 */
export interface GateSwitches {
	/** ⑤ 资料版本比对 */
	readonly sourceVersion: boolean;
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
	/**
	 * `CachePolicy` 为这一条定的 TTL，随票据流到写入路径。
	 *
	 * 优先级：`WriteOptions.ttlMs`（调用方显式给的）> 这里 > 全局 `ttlMs`。
	 * 策略说「这类只活十分钟」不该压过调用方在具体某一条上的明确指定。
	 */
	readonly ttlMs?: number | null;
}

export type LookupOutcome =
	/** 精确命中且过了全部校验 */
	| "exact"
	/** 语义命中且过了全部校验 */
	| "reuse"
	/** 没有可用条目 */
	| "miss"
	/**
	 * 影子模式：**闸全跑了，但结果不作数** —— 真实结果在 `wouldHave` 里。
	 *
	 * 上线一个概率型缓存最需要的一步：在生产流量上跑完整条判定链，却仍然每次都
	 * 真生成，用来回答「开了会不会返回错答案」。所以影子模式下读路径**严格只读** ——
	 * 不复用、不驱逐、不 touch，评估本身不该改变被评估的东西。
	 */
	| "shadow"
	/**
	 * `CachePolicy` 的 `noCache` 生效 —— **一道闸都没跑**。
	 *
	 * 和 `miss` 是两回事：`miss` 是查过了没有，`bypass` 是压根没查。
	 * 注意它只说明**没读**；写不写由 `noStoreReason` 决定，两者正交。
	 */
	| "bypass";

/**
 * 只读匹配的结果。
 *
 * **`lookup` 不生成、也不写入新条目**，但它会驱逐被 ⑤ 判定为失效的旧条目 ——
 * 那是维护，不是写入：一条版本已过期的缓存，读到它的那一刻就该消失，
 * 留着只会让下一个请求再判一次。
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
	 * `CachePolicy` 说「别读」的理由；没说就是 null。
	 *
	 * 放在结果上而不是 `trace` 里，是因为一道闸都没跑 —— 记成某道闸的判定
	 * 就是假话。非 null 等价于 `outcome === "bypass"`。
	 */
	/**
	 * 影子模式下**本来会是什么结果**；非影子模式为 null。
	 *
	 * `outcome === "shadow"` 时它必然非 null。和 `GateVerdict` 的 `would-exit`
	 * 是同一个思路，只是抬到了整条链路的层面。
	 */
	readonly wouldHave: LookupOutcome | null;
	readonly noCacheReason: string | null;
	/**
	 * `CachePolicy` 说「别写」的理由；没说就是 null。
	 *
	 * 非 null 时 `prepareWrite()` 必然抛。它和 `noCacheReason` 正交：
	 * 「重新回答」只有前者，「出五道练习题」只有后者。
	 */
	readonly noStoreReason: string | null;
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
