# @jolli.ai/semantic-cache

分层语义缓存。把「问题像不像」和「旧答案还成不成立」拆成各管一类失效的闸，
并强制每个模型角色上线前先过判别力自检。

零依赖，TypeScript，存储与检索都是端口 —— 接进任何已有的 RAG 应用只需实现几个接口。

## 设计架构

### 一、分层：库不认识 PII，也不认识你的业务

```
应用
 │
 ├─ 意图路由                        决定这个问题走哪条路
 │    ├ 个人数据 / 结构化查询  →  工具调用 + 授权检查   → 缓存 plan
 │    └ 学科内容问答          →  RAG                  → 缓存 answer
 │
 ├─ PII 层                          检测 · 脱敏 · 还原 · 能否跨主体共享
 │    └ 产出两份文本：matchText（脱敏后）+ retrievalText（保留实体）
 │
 └─ @jolli.ai/semantic-cache
      不认识 PII · 不实现检索 · 不实现存储 · 不调用 LLM
      只回答一个问题：这次该不该复用，复用哪一条
```

个人数据不进可检索语料，是**路由层**的事；脱敏与还原是 **PII 层**的事。
库只守一条边界：声明为已脱敏的请求，不允许把 **answer** 条目放进共享 scope。

### 二、端口：什么由你提供，什么库内固定

```
                你提供                        库内固定，不给选
  ──────────────────────────────────────────────────────────────────
  打分   RecallStage                     ⑥ 的算子固定为 top-1
         RerankStage（可选）              阈值必须跟打分器一起给
         SupportStage
  存储   CacheStore                      scope + 未过期 的 pre-filter
         （内存 / pgvector 两个现成实现）
  检索   Retriever                       —
  隔离   ScopeResolver                   脱敏 × 共享 × answer ⇒ 抛错
  版本   SourceVersionResolver           按引用资料比对，非相似度
  生成   Generate / Refine（可选）        何时调用由库决定
  向量   ——（一律库内计算）                答案用 passage 侧编码
```

**向量不由调用方传**，是为了堵死跨向量空间比较：答案必须用检索模型的 passage 侧
编码，才能和检索片段比。用句对模型编码答案、用检索模型编码片段，余弦没有意义。

### 三、读路径：六道闸与两种载荷

```
  resolve(prompt, generate)
        │
   ①  scope 门控          ← ScopeResolver（你的隔离策略）
        │                   redacted × shared × answer ⇒ 抛错
        ▼
   ②  精确匹配 ─── hit ──────────────┐
        │ miss                       │
        ▼                            │
   ③  向量召回 top-k                  │   无候选 / < recall.floor ─→ 生成
        │ pass                       │
        ▼                            │
   ④  精排（有 RerankStage 才存在）    │   < rerank.floor ─────────→ 生成
        │ pass                       │
        └──────────┬─────────────────┘
                   ▼
            kind == "plan" ? ── 是 ──→ 返回计划（⑤⑥ 不适用）
                   │ 否                 实体是参数，执行时填参 + 授权
                   ▼
   ⑤  资料版本比对          版本不符 ── evict ──→ 生成
        │ 一致
        ▼
   ⑥  回答校验（对 top-1）   < support.low ── evict ──→ 生成
        │
        ▼
     支撑度 ≥ support.high ? ── 是 ──→ 复用
                            └─ 否 ──→ 微调（有 Refine）/ 否则生成
```

**② 命中也要过 ⑤⑥**：缓存键建在脱敏文本上时，占位符塌陷对精确匹配同样成立。

**⑤⑥ 的分数无论开关都会算出来**，关掉时 trace 标 `would-exit` —— 一次运行就能
看出"关掉会怎样"，不用重跑。

### 四、三个打分器角色与阈值绑定

```
  角色       比什么                  尺度            阈值
  ─────────────────────────────────────────────────────────────────
  recall     问题 ↔ 缓存里的问题      句对模型的余弦    floor
  rerank?    问题 ↔ 缓存里的问题      该重排器自己的     floor
             （或 ↔ 缓存的答案）
  support    答案 ↔ top-1 检索片段    检索模型 passage  high / low
```

三个尺度**互不可换**。所以阈值不是一个独立的 `thresholds` 配置块，而是和打分器
捆在一个 `Calibrated<Scorer, Thresholds>` 里，还带一个必填的 `calibratedOn` —— 
换打分器就拿不到旧阈值，也留下了这组阈值是在什么数据上标的。

**没有 `RerankStage` 就是没有 ④ 这道闸**，不会退化成"拿它的闸值去卡召回余弦"。
那条退化路径正是尺度混用的来源，已经删掉；想在无精排时收紧问题侧，
调 `recall.thresholds.floor`。

## 为什么不是「加个向量库 + 一个阈值」

单一余弦阈值管不了三类不同的失效，因为它们需要的证据类型不同：

| 失效 | 例子 | 需要的证据 | 由谁管 |
|---|---|---|---|
| 意图之差 | 「什么是过拟合」vs「什么是欠拟合」 | 更强的语义判别力 | ④ 精排 —— **前提是模型任务匹配**，见文末 |
| 资料改版 | 老师改了大纲，旧答案引的是上一版 | 版本事实（可直接查） | ⑤ 版本比对 |
| 实体塌陷 · 同词不同指 | 「Hinton 提出了什么」vs「LeCun 提出了什么」；「归一化」在两章各指一事 | 问题侧看不出，但检索结果不同 | ⑥ 回答校验 |

指望一个阈值同时管住三件事，只能得到一个既漏又误的中间值。

## 接入

```ts
import { createSemanticCache, createMemoryCacheStore } from "@jolli.ai/semantic-cache";

const calibratedOn = "2026-08 生产日志 400 条人工标注，⑥ 用 top-1 算子";

const cache = createSemanticCache({
  // 每个打分器和**为它标定的**阈值捆在一起 —— 换打分器就拿不到旧阈值
  recall:  { scorer: pairEncoder,      thresholds: { floor: 0.62 },            calibratedOn },
  rerank:  { scorer: reranker,         thresholds: { floor: 0.79 },            calibratedOn },
  support: { scorer: retrievalEncoder, thresholds: { high: 0.92, low: 0.90 },  calibratedOn },

  store: createMemoryCacheStore(),          // 或 createPgVectorCacheStore({ sql: pool, dimensions })
  retriever: yourExistingRagRetriever,      // 你自己的检索，库不实现
  scope: prompt => prompt.redacted                // PII 策略写在这里，库不认识 PII
    ? { key: `user:${prompt.context.userId}`,   shared: false }
    : { key: `course:${prompt.context.courseId}`, shared: true },
  sourceVersion: ids => fingerprintOf(ids), // 必须是**引用资料级**的
});

// 包住你原来的生成调用即可 —— 库决定要不要调它
const result = await cache.resolve(
  { matchText, retrievalText, redacted, context },
  async (prompt, chunks) => ({
    kind: "answer",                          // 或 kind: "plan"（工具类问题）
    answer: await yourLlm(prompt, chunks),
    sourceIds: chunks.map(c => c.id),
  }),
);
// result.outcome: "exact" | "reuse" | "refine" | "generated"
// result.payload: { kind: "answer", ... } | { kind: "plan", plan }
// result.trace:   逐闸判定，含分数、标定出处与「本会拦下」标记
```

### 拆开用：匹配 / 写入 / 获取 / 失效

`resolve` 是下面这几件事的组合。生成不在库里的时候 —— 外部服务、要人工审核、
想先看命中结果再决定用哪个模型 —— 自己拼这条路：

```ts
const found = await cache.lookup(prompt);        // ①～⑥，不生成、不写新条目
// found.outcome: "exact" | "reuse" | "mid" | "miss"
// found.chunks:  ⑥ 已检索的片段；没走到 ⑥ 时是 null，那就得自己检索
// found.support: ⑥ 的支撑度

if (found.outcome === "miss") {
  const chunks = found.chunks ?? (await yourRetriever.retrieve(prompt.retrievalText, prompt.context));
  const produced = await yourLlm(prompt, chunks);
  await cache.write(prompt, produced, {
    ticket: await found.prepareWrite(),   // lookup 已解好的 scope/哈希/向量；不传就现算
    meta: { model: "claude-opus-5" },     // 你自己的记账字段，库不解释它的内容
    ttlMs: 10 * 60 * 1000,                // 这一条的存活时长，覆盖全局；null = 不过期
  });
}

await cache.writeMany(items);        // 批量预热/回填：两次批量编码，不是 2N 次单条调用
await cache.get(entryId);            // 按 id 取回条目（只返回未过期的）
await cache.evict(entryId);          // 删一条；也可以传一个 id 数组
await cache.clear("course:ml101");   // 清一个 scope，返回删掉的条数
await cache.invalidateSource("n5");  // 资料改版后按资料 id 批量失效
await cache.purgeExpired();          // 删掉已过期的行，挂定时任务调；不影响正确性，只管存储占用
```

`writeMany` 不是 `write` 的语法糖：它把 N 条的召回向量和答案向量各合并成**一次**
编码调用。灌 30 条干扰缓存或从历史日志回填时，差的是 2 次模型调用还是 60 次。

`clear` **必须给 scope**。无参数的全清在生产上几乎总是误操作，真要全清就对存储调
`InspectableCacheStore.clear()` —— 让它显眼一点，别藏在缓存对象的方法里。

### 和主流语义缓存的对应关系

| GPTCache / RedisVL / LangChain | 这里 |
|---|---|
| `adapter.openai` 包装 · `set_llm_cache` | `resolve(prompt, generate)` |
| `cache.check(prompt, filters)` · `BaseCache.lookup` | `lookup(prompt)` |
| `cache.store(prompt, response, metadata, ttl)` · `BaseCache.update` | `write(prompt, payload, { meta, ttlMs })` |
| `cache.import_data(questions, answers)` | `writeMany(items)` |
| `cache.drop(ids=[...])` | `evict(id \| ids)` |
| `cache.clear()` | `clear(scope)` — 见上，必须给 scope |
| `filters` / `filter_expression` · `llm_string` | `ScopeResolver`（模型要不要进 key 由你决定） |
| `cache.set_threshold(0.2)` | **故意没有** |
| GPTCache 的 session 并发去重 | `singleFlight`（默认开，仅进程内） |
| — | `invalidateSource(id)`、⑤ 资料版本、⑥ 回答校验（主流都没有） |

**并发合流默认开**：同一个问题的 N 个并发请求只走一次完整流程，后到的拿同一个结果
（也共享同一份 trace 和第一个请求的 `writeOptions`）。合流键里带 `retrievalText` ——
匿名化之后两个学生的 `matchText` 会相同而实体不同，只按 matchText 合流等于亲手制造
占位符塌陷。只在进程内合流；跨进程重复生成是浪费不是错误，为它引入分布式锁不划算。

**没有 `set_threshold` 是有意的。** 阈值和打分器、`calibratedOn` 捆在一起给，
运行时单独改阈值等于让它脱离标定 —— 那个数就成了「在别人语料上标出来的产物」，
正是这套 API 一路在堵的失效。要改阈值，重新标定后换整个 stage。

LangChain 把 `llm_string`（模型名 + 参数）放进缓存键，所以换个模型必然不命中。
这里不预设：要按模型隔离就在 `ScopeResolver` 里写 `course:${c}|model:${m}`，
要跨模型共享就不写 —— 答案是对同一份语料的 RAG，内容本不该因客户端而异。

`lookup` **不写新条目，但会驱逐被 ⑤⑥ 判定失效的旧条目** —— 那是维护不是写入：
一条版本已过期、或已不被语料支撑的缓存，读到它的那一刻就该消失。
中带（`"mid"`）条目 `lookup` 不驱逐，它没失效，只是不够有把握，留不留由你决定 ——
`resolve` 走到中带时会替换或重生成它，那是 `resolve` 的策略，不是 `lookup` 的行为。

### 检索故障时缓存状态不变

⑥ 把「判不了」和「判定为无效」分开：检索没返回任何片段时本次不复用，但**不驱逐**。
否则 retriever 一次超时就会让每一次读顺手删掉它读到的那条，一次故障静默清空整个缓存。

另一半在写入侧：**没有任何资料依据的 answer 不写入**（`sourceIds` 为空）。这种条目
⑤ 和 `invalidateSource` 都够不着，而 `getByHash` 取最新 —— 它会稳稳顶掉那条本来好好的
旧缓存。此时 `resolve` 返回 `outcome: "generated"` 且 `entryId: null`，意思是生成了但没落缓存。

两半都到位，一次检索故障才真的不改变缓存状态。

`invalidateSource` 和 ⑤ 不是二选一：⑤ 是**读时**的懒失效，条目要等被读到才发现
版本不符；老师改完大纲就调一次 `invalidateSource`，等于把那一批提前失效，⑤ 仍是兜底。

### 存储：内存与 pgvector

```ts
import { Pool } from "pg";
import { createPgVectorCacheStore } from "@jolli.ai/semantic-cache";

const store = createPgVectorCacheStore({
  sql: new Pool({ connectionString }),      // pg 的 Pool/Client 天然满足 SqlExecutor
  dimensions: { match: 384, answer: 384 },  // 从你的编码器上量，别写死
  table: "semantic_cache",                  // 默认值
  ann: false,                               // true 建 HNSW；默认 scope 内精确 KNN
});
await store.ensureSchema();                  // 幂等，可以放在启动路径上
```

SDK **不依赖 `pg`** —— `SqlExecutor` 只有一个 `query(text, values)`，连接池由你传进来。

两个向量落两列且维度可以不同（`match_vector` 是 PairEncoder 空间，`answer_vector`
是 RetrievalEncoder 的 passage 空间）。`ensureSchema` 会校验已有表的维度对不对得上，
换了编码器而表还是老的会当场报错，而不是等插入时炸一个看不懂的底层错误。

**一处不能忽略的精度差异**：`vector` 列是 float4，JS 的 number 是 float8，向量写进去
就被舍到单精度（往返偏差约 6e-8）。量级远小于任何标定出来的阈值间距，但恰好压在
阈值上的样本可能倒向另一边 —— **阈值在哪个后端上标定，就在哪个后端上验**。
pgvector 没有 float8 的向量类型，这不是换写法能绕开的。

## API 里固化的教训

这些不是风格选择，是实测踩出来的，所以做成了类型层面绕不过去的形状。

### 1. `matchText` 和 `retrievalText` 是两个必填字段

上游做了 PII 匿名化时，缓存键必须建在匿名化后的文本上，而**检索必须用保留实体的原文**。
两者混用时，回答校验对实体塌陷完全失明 —— 两个不同的人检出同一批片段，这一层就废了。

实测：把检索换成匿名化后的文本，13 条用例里多漏 2 条，**精确就是两条实体塌陷**，
其余 11 条判定完全不变。是选择性失效，不是整体失效。

没有匿名化的应用把两者传成同一个字符串即可。

### 1.5 PII 过滤在 SDK 之上，但边界由 SDK 守

库不认识 PII —— 检测引擎（Presidio / Comprehend / 正则）和合规要求各家不同，
不该由缓存库来理解。**分层是：应用 → PII 层（检测/脱敏/还原）→ 本 SDK。**

但这个分层有个构造上必然的陷阱，SDK 必须堵死：

脱敏之后，「张三的作业二扣了多少」和「李四的作业二扣了多少」变成**同一个字符串**。
它们塌成同一个缓存键，而答案里带着 `<PERSON_1>` 占位符 —— 跨主体复用时用当前请求
的实体映射去还原，就会把甲的答案安上乙的名字。这不是概率问题，是必然。

所以契约是两条：

```ts
await cache.resolve({
  matchText: redactedText,      // 脱敏后 —— 缓存键建在它上面
  retrievalText: originalText,  // 保留实体的原文 —— 检索必须用它
  redacted: true,               // 如实声明
  context: { userId },
}, generate);

// ScopeResolver 必须为脱敏请求返回隔离 scope
scope: prompt => prompt.redacted
  ? { key: `user:${prompt.context.userId}`, shared: false }
  : { key: `course:${prompt.context.courseId}`, shared: true },
```

`redacted: true` 落进 `shared: true` 的 scope，SDK **直接抛错**。只返回字符串的
ScopeResolver 会被保守地当作共享 scope。

**还原（de-anonymization）一律在 SDK 之上做，而且只对本主体的条目做。**
库返回的 `answer` 是原样存的文本；跨主体还原从来都不安全，隔离 scope 就是为此。

一句话：声明是第一道防线，⑥ 回答校验是**声明缺失时**的兜底 —— 现实中最常见的
失误就是上层忘了声明。两道都要有。

### 1.8 支撑度用 top-1，且标定与实现必须同算子

「旧答案是否仍被检索片段支撑」要落成具体算子，三种写法差别巨大：

| 算子 | 语义 | 失效方式 |
|---|---|---|
| 对 top-k 取重心 | 和这批片段整体像不像 | 片段少时无关的也被捞进来，平均后信号稀释 |
| 对 top-k 取 max | 有某个片段撑得住旧答案 | **旧答案自己的来源片段常常还在 top-k 里**，跟自己比当然高分 |
| 对 **top-1** 比 | 旧答案和现在会据以回答的那篇一不一致 | 选用 |

取 max 那次很具体：问「Breiman 提出了什么方法」，检索回来的三篇里仍含 Vapnik 那篇，
而缓存答案正是从它生成的，支撑度被自己的来源顶到高位，塌陷放行。

**更隐蔽的是它让标定失效。**标定拿「答案 ↔ 单篇文档」比、实现却取 top-k 的 max，
两者不是同一个算子，标出来的阈值根本不适用 —— 而后果不是报错，是把实现缺陷
当成机制的固有边界写进结论。库内固定为 top-1，就是不让调用方在这里做选择。

### 2. 三个模型角色分开，不能共用

```ts
interface PairEncoder      { embedQuestions(t) }              // 问题↔问题（对称）
interface RetrievalEncoder { embedQuery(t); embedPassage(t) } // 问题↔段落（非对称）
interface Reranker         { score(query, candidate) }        // 精排
```

实测两次任务错配，**都不报错**：

- 拿句对模型（`paraphrase-*`）做检索：「什么是过拟合？」top-1 是**批归一化**（0.366）；
  换成检索训练的模型后是「过拟合」（0.888），top-1 命中 7/7。
- 拿段落重排器（`ms-marco`）比问题↔问题：中文上四组难度递减的输入全部落在
  0.9975–0.9988，**跨度 0.0013**。

两次都是模型正常加载、返回合法的 0~1 分数、程序跑完。你会拿着这些数去标定阈值 ——
而标定一个常数，标出来的阈值当然也没有意义。

**顺带一个设计选择**：`Reranker.score(query, candidate)` 的 `candidate` 传什么由你决定。
传缓存里的旧**问题**，需要句对训练的模型；传旧**答案**，就正好是 query→passage，
段落重排器适用。后者语义上也更直接：「这条缓存的答案，回答得了我这个问题吗？」

### 3. 回答向量与检索片段必须在同一个向量空间

库自己负责所有 embedding，调用方不传向量 —— 就是为了防止这件事。
答案一律用 `RetrievalEncoder.embedPassage` 编码，才能和检索片段比。
用句对模型编码答案、用检索模型编码片段，算出来的余弦没有任何意义
（这个 bug 我自己犯过，`cosine()` 的维度检查就是那次加的）。

### 4. `recallLimit` 必须大于 1

只召回 1 条时精排没有候选可排，④ 退化成二元判断 ——
此时任何关于「精排值不值」的度量都不成立。构造时直接抛错。

## 上线前：判别力自检

```ts
import { checkRetrievalEncoder, assertDiscriminates } from "@jolli.ai/semantic-cache";

const report = await checkRetrievalEncoder(retrieval, [
  { label: "该命中", a: "什么是过拟合？", b: overfittingDoc, shouldMatch: true },
  { label: "不该命中", a: "什么是过拟合？", b: batchNormDoc,  shouldMatch: false },
]);
assertDiscriminates(report);   // 分不开就抛，别让任务错配的模型上线
```

`margin = 正例最低分 − 负例最高分`。大于 0 才说明两组可分。
**把它放进 CI**：这是唯一能在上线前抓到任务错配的手段，十分钟的事。

## 离线标定与 A/B

```ts
import { evaluate, compare } from "@jolli.ai/semantic-cache";

const withGate  = await evaluate(cacheWithAnswerCheck, scenarios, generate, hooks);
const without   = await evaluate(cacheWithoutAnswerCheck, scenarios, generate, hooks);
compare(withGate, without).falseHitDelta;  // 这道闸的价值
```

两条约定：

- **判据是「答案的首要依据是不是那篇资料」，不是「有没有复用」。**
  缓存里有真实规模的历史条目之后，探测问题可能命中另一条**内容正确**的缓存 —— 那是成功。
  而且必须落在**首要依据**上：只要期望文档出现在 top-k 里就算过，
  会把「复用了过拟合的答案给问欠拟合的学生」判成通过。
- **`hooks.warm` 要灌真实规模的干扰缓存。** 不灌的话召回永远只有 1 条候选。

标定方法照搬行业做法：从生产日志抽 100–500 条真实请求人工标注，
画 precision/recall 曲线定阈值，precision ≥ 95% 再放量，shadow mode 先行。
**默认阈值只是占位，必须在你自己的数据上重标。**

## 诚实的边界

- ⑥ 用的是 bi-encoder 余弦，测的是「同主题」而非「仍成立」。它抓得住实体塌陷
  （检索结果整体换了一批），抓不住细粒度的过期 —— 那是 ⑤ 的活，别指望 ⑥ 兜底。
- **④ 用任务错配的重排器时是负收益，不是"效果差一点"。**实测 13 条用例：
  开与关假命中同为 0，复用 3（开）vs 5（关) —— 零精度提升，砍掉 2 次合法复用。
  探针层面它确实把不可分（−0.2936）变成勉强可分（+0.0344），但那是
  `ms-marco` 在"完全无关"那种容易负例上的功劳；近义反义只差 0.0344。
  换成句对相似度训练的模型会怎样，**没有验证过**。
  加这一层之前，先用 `checkReranker` 证明它在你的数据上拉得开分。
- 当前测得的 ⑥ 贡献被**坏掉的 ④ 夸大**了 —— ④ 失效时 ⑥ 在替召回层兜底。
  换上任务匹配的精排模型后，⑥ 的边际贡献预计明显变小。
- 语义缓存是概率型缓存。零风险的省钱手段（provider prompt caching、精确缓存、
  头部问题策展）该先吃满，它排在这些之后。
