# @jolli.ai/semantic-cache

分层语义缓存。把「问题像不像」和「旧答案还成不成立」拆成各管一类失效的闸，
并强制每个模型角色上线前先过判别力自检。

零依赖，TypeScript。**库只实现判定逻辑**：存储、检索、打分、生成全部由你传进来 ——
接进已有的 RAG 应用，就是把你现成的那几样包成库要的接口形状。

> 想知道**为什么**这么设计 —— 六道闸各管什么、为什么阈值必须跟着打分器走、
> 每条约束背后是哪次踩坑 —— 看 [`DESIGN.md`](DESIGN.md)。

## 接入

```ts
import { createSemanticCache, createMemoryCacheStore } from "@jolli.ai/semantic-cache";

const calibratedOn = "2026-08 生产日志 400 条人工标注，⑥ 用 top-1 算子";

const cache = createSemanticCache({
  // 每个打分器和**为它标定的**阈值捆在一起 —— 换打分器就拿不到旧阈值
  recall:  { scorer: pairEncoder,      thresholds: { floor: 0.62 },           calibratedOn },
  // ④ 的 target 决定拿旧问题还是旧答案跟新问题比 —— 两者尺度不同，θq 不通用。
  // "answer" 是 query→passage，段落重排器（bge-reranker 一类）适用
  rerank:  { scorer: reranker,         thresholds: { floor: 0.35, target: "answer" }, calibratedOn },
  support: { scorer: retrievalEncoder, thresholds: { high: 0.92, low: 0.90 }, calibratedOn },

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

**替换一律「先写新的，写成了才删旧的」。** 生成抛错、写入抛错、或者产物没有资料依据，
三种情况旧条目都留着 —— 反过来（先删后写）的话，一次生成失败就净丢一条本来还能用的缓存。
代价是同 (scope, matchHash) 的两条会共存几毫秒，这是安全的：`getByHash` 取最新的那条。

### 检索故障时缓存状态不变

⑥ 把「判不了」和「判定为无效」分开：检索没返回任何片段时本次不复用，但**不驱逐**。
否则 retriever 一次超时就会让每一次读顺手删掉它读到的那条，一次故障静默清空整个缓存。

另一半在写入侧：**没有任何资料依据的 answer 不写入**（`sourceIds` 为空）。这种条目
⑤ 和 `invalidateSource` 都够不着，而 `getByHash` 取最新 —— 它会稳稳顶掉那条本来好好的
旧缓存。此时 `resolve` 返回 `outcome: "generated"` 且 `entryId: null`，意思是生成了但没落缓存。

还有第三处同源：**中带条目的替换是先写后删**（见上），所以生成失败也不会把它删掉。
三处都到位，一次检索故障或一次生成失败才真的不改变缓存状态。

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

**别用「分数跨度」代替 margin。** 跨度只看最大值减最小值，一个把「完全无关」打得比
「同义改写」还高的打分器（顺序整个反过来、毫无用处）只要分数摊得开就能过关。
验证台先前就是这么判的，`test/Discrimination.test.ts` 里留着那个反例。

## 测试

```bash
node --experimental-strip-types example/Smoke.ts   # 端到端冒烟，失败退非 0
npm run test                                       # node:test，零依赖，不下载模型
npm install && npm run typecheck                   # tsc 要装，其余都不用
```

单测守的是**出错也不报错**的那些不变式：⑥ 的算子是 top-1（取 max 会被旧答案自己的来源
顶起来）、票据配错 prompt、没有依据的答案不写入、检索故障不驱逐、中带替换先写后删、
判别力判据是 margin。每一条都对应 [`../FINDINGS.md`](../FINDINGS.md#踩过的坑) 里的一个坑 ——
散文守不住它们，一行实现改错了不会有任何东西变红。

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

## 并发

正常用法是被 web backend 并发调用。要点：**不会坏数据**；同一个问题的并发请求
进程内合流（默认开）；**跨进程并发未命中会产生重复条目** —— 浪费而非错误，
`getByHash` 保证返回确定的那一条，多余的行由 TTL 与 `purgeExpired()` 收。

写自己的 `CacheStore` 之前先读 [`DESIGN.md` 的并发一节](DESIGN.md#并发)，
那里有两条对存储实现的硬要求。

## 边界

这个库**不适合**所有场景，也有已知拿不到的东西。上线前先读
[`DESIGN.md` 的「诚实的边界」](DESIGN.md#诚实的边界)。
