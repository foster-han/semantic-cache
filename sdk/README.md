# @jolli.ai/semantic-cache

分层语义缓存。把「问题像不像」和「旧答案还成不成立」拆成各管一类失效的闸，
并强制每个模型角色上线前先过判别力自检。

零依赖，TypeScript。**库只实现判定逻辑**：存储、检索、打分、生成全部由你传进来 ——
接进已有的 RAG 应用，就是把你现成的那几样包成库要的接口形状。

> 想知道**为什么**这么设计 —— 五道闸各管什么、为什么阈值必须跟着打分器走、
> 每条约束背后是哪次踩坑 —— 看 [`DESIGN.md`](DESIGN.md)。

## 接入

```ts
import { createSemanticCache, createMemoryCacheStore } from "@jolli.ai/semantic-cache";

const calibratedOn = "2026-08 生产日志 400 条人工标注，④ 用 bge-reranker-base 的问↔答形态";

const cache = createSemanticCache({
  // 每个打分器和**为它标定的**阈值捆在一起 —— 换打分器就拿不到旧阈值
  recall:  { scorer: pairEncoder,      thresholds: { floor: 0.62 },           calibratedOn },
  // ④ 的 target 决定拿旧问题还是旧答案跟新问题比 —— 两者尺度不同，θq 不通用。
  // "answer" 是 query→passage，段落重排器（bge-reranker 一类）适用
  rerank:  { scorer: reranker,         thresholds: { floor: 0.35, target: "answer" }, calibratedOn },

  store: createMemoryCacheStore(),          // 或 createPgVectorCacheStore({ sql: pool, dimensions })
  retriever: yourExistingRagRetriever,      // 你自己的检索，库不实现
  // PII 策略写在这里，库不认识 PII。三个字段都必填：org 漏了会静默跨租户，
  // 所以库不接受「只给 key」的简写，也不让你自己拼这个字符串
  scope: prompt => prompt.redacted
    ? { org: prompt.context.orgId, key: `user:${prompt.context.userId}`,   shared: false }
    : { org: prompt.context.orgId, key: `course:${prompt.context.courseId}`, shared: true },
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
// result.outcome: "exact" | "reuse" | "generated" | "bypassed"
// result.payload: { kind: "answer", ... } | { kind: "plan", plan }
// result.trace:   逐闸判定，含分数、标定出处与「本会拦下」标记
```

### 拆开用：匹配 / 写入 / 获取 / 失效

`resolve` 是下面这几件事的组合。生成不在库里的时候 —— 外部服务、要人工审核、
想先看命中结果再决定用哪个模型 —— 自己拼这条路：

```ts
const found = await cache.lookup(prompt);        // ①～⑤，不生成、不写新条目
// found.outcome: "exact" | "reuse" | "miss"（另有 "shadow" / "bypass"）
// found.exitedAt: 被哪道闸拦下；命中时是 null

if (found.outcome === "miss") {
  const chunks = await yourRetriever.retrieve(prompt.retrievalText, prompt.context);
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
await cache.clear({ org: "acme", key: "course:ml101" });  // 清一个 scope，返回删掉的条数
await cache.invalidateSource("n5");  // 资料改版后按资料 id 批量失效
await cache.purgeExpired();          // 删掉已过期的行，挂定时任务调；不影响正确性，只管存储占用
```

`writeMany` 不是 `write` 的语法糖：它把 N 条的召回向量合并成**一次**编码调用，
版本指纹也按 `sourceIds` 去重（批量回填常常整批共用同一组资料）。灌 30 条干扰缓存
或从历史日志回填时，差的是 1 次模型调用还是 30 次。

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
| `cache.clear()` | `clear({ org, key })` — 见上，必须给 scope，且由库来拼 |
| `filters` / `filter_expression` · `llm_string` | `ScopeResolver`（模型要不要进 key 由你决定） |
| `cache.set_threshold(0.2)` · `cache_factor` | **故意没有** —— 阈值绑在 `Calibrated<>` 上 |
| `cache_enable_func` · `cache: {no-cache, no-store}` | `CachePolicy`（读写正交、理由必填、`noStore` ⇒ 票据抛） |
| GPTCache 的 session 并发去重 | `singleFlight`（默认开，仅进程内） |
| — | `invalidateSource(id)`、⑤ 资料版本、`suggestThreshold()` 逐语料标定（主流都没有） |

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

`lookup` **不写新条目，但会驱逐被 ⑤ 判定失效的旧条目** —— 那是维护不是写入：
一条版本已过期的缓存，读到它的那一刻就该消失，留着只会让下一个请求再判一次。

**替换一律「先写新的，写成了才删旧的」。** 生成抛错、写入抛错、或者产物没有资料依据，
三种情况旧条目都留着 —— 反过来（先删后写）的话，一次生成失败就净丢一条本来还能用的缓存。
代价是同 (scope, matchHash) 的两条会共存几毫秒，这是安全的：`getByHash` 取最新的那条。

### 一次生成失败不改变缓存状态

**没有任何资料依据的 answer 不写入**（`sourceIds` 为空）。这种条目 ⑤ 和
`invalidateSource` 都够不着，而 `getByHash` 取最新 —— 它会稳稳顶掉那条本来好好的旧缓存。
此时 `resolve` 返回 `outcome: "generated"` 且 `entryId: null`，意思是生成了但没落缓存。

配上「先写后删」，一次生成失败或一次检索故障才真的不改变缓存状态：读路径不驱逐
任何东西（除了 ⑤ 判出的版本失效），写路径拒收没有依据的产物。

`invalidateSource` 和 ⑤ 不是二选一：⑤ 是**读时**的懒失效，条目要等被读到才发现
版本不符；老师改完大纲就调一次 `invalidateSource`，等于把那一批提前失效，⑤ 仍是兜底。

### 存储：内存与 pgvector

```ts
import { Pool } from "pg";
import { createPgVectorCacheStore } from "@jolli.ai/semantic-cache";

const store = createPgVectorCacheStore({
  sql: new Pool({ connectionString }),      // pg 的 Pool/Client 天然满足 SqlExecutor
  dimensions: { match: 384 },               // 从你的编码器上量，别写死
  table: "semantic_cache",                  // 默认值
  ann: false,                               // true 建 HNSW；默认 scope 内精确 KNN
});
await store.ensureSchema();                  // 幂等，可以放在启动路径上
```

SDK **不依赖 `pg`** —— `SqlExecutor` 只有一个 `query(text, values)`，连接池由你传进来。

`ensureSchema` 会校验已有表的向量维度对不对得上，换了编码器而表还是老的会当场报错，
而不是等插入时炸一个看不懂的底层错误。

**一处不能忽略的精度差异**：`vector` 列是 float4，JS 的 number 是 float8，向量写进去
就被舍到单精度（往返偏差约 6e-8）。量级远小于任何标定出来的阈值间距，但恰好压在
阈值上的样本可能倒向另一边 —— **阈值在哪个后端上标定，就在哪个后端上验**。
pgvector 没有 float8 的向量类型，这不是换写法能绕开的。

## 决定哪些请求不走缓存

有一类问题是**从来就不该被写进缓存**的：「那第二个呢」（离开这次对话，问题本身就不
完整）、「帮我提交作业」（是动作不是问答）。这类判定必须在五道闸**之前** —— 交给闸拦
的话，要走完召回和精排才发现不该用，而且拦不住写入，下次就是一次假命中。

```ts
import { createStructuralPolicy, combinePolicies } from "@jolli.ai/semantic-cache";

const policy = createStructuralPolicy({
  bypassWhen:   { needsHistory: "依赖对话上下文", hasSideEffect: "是动作，应走 plan" },
  noCacheWhen:  { regenerate: "学生要求重新回答" },
  noStoreWhen:  { openEnded: "开放生成，没有唯一答案" },
  shortTtlWhen: { timeSensitive: 10 * 60_000 },
  // 调用类型白名单。下面这行是默认值，不写也一样
  allowedCallTypes: ["completion", "responses", "anthropic_messages"],
});

createSemanticCache({ /* … */, policy });
```

两个开关**正交**，借的是 HTTP `Cache-Control` 的语义：

| `noCache` | `noStore` | 行为 | 场景 |
|---|---|---|---|
| — | — | 查、命中就复用；没命中就生成并存 | 绝大多数问题 |
| ✓ | ✓ | 不查、生成、不存 | 「那第二个呢」 |
| ✓ | — | 不查、强制生成、**写回替换旧的** | 「重新回答」 |
| — | ✓ | 照常查，没命中就生成但不存 | 「出五道练习题」 |

第三行是一个布尔开关表达不出来的：学生嫌答案简略点了「重新回答」，必须跳过查询
（不然原样再吐一遍），但新答案该写回去替换旧的 —— 一个人的一次不满意变成对所有人
的改进。**注意 key 不变**（还是原来那个问题），所以写入时旧条目被自动替换；
如果重生成时改了问法，用 `WriteOptions.supersedes` 显式指定要替换哪条。

### 只有 chat 形态该走语义缓存

`allowedCallTypes` 是个白名单，默认只含 `completion` / `responses` /
`anthropic_messages`（`DEFAULT_SEMANTIC_CALL_TYPES`，异步的 `a` 前缀变体自动认）。
调用方在 `context.callType` 里标这次是什么调用，不在列的直接 `noCache` + `noStore`。

判据是**输出是不是输入的确定函数**：

| 调用类型 | 输出确定吗 | 该走哪种缓存 |
|---|---|---|
| `completion` / `responses` / `anthropic_messages` | ❌ 有采样 | **语义缓存** —— 才需要这五道闸 |
| `embedding` | ✅ 同文本 → 同向量 | 精确缓存（内容哈希） |
| `rerank` | ✅ 同 query+文档集 → 同分数 | 精确缓存 |
| `transcription` | ✅ 同文件 → 同转写 | 精确缓存（文件哈希） |
| `text_completion` | — | 老式接口 |

**被排除不等于不该缓存,恰恰相反。**后四类走精确缓存是零假命中风险、命中即赚的一档，
应该先吃满 —— 它们只是不该走**这一层**。拿相似度去匹配 embedding，等于用「差不多的
文本」换一个「差不多的向量」，正好摧毁向量本身的意义；两段「相似」的音频也不是同一段。

用白名单而不是黑名单：漏配一个新出现的调用类型，后果是「这类没走语义缓存」（少一次
命中，便宜），而不是「一类不该语义匹配的东西被语义匹配了」（错答案，贵）。

没标 `callType` 时默认**放行** —— 这个库的入口只有 `resolve(prompt, generate)`，
本来就只处理 chat 形态。如果你把多种调用都路由到这一层，打开 `requireCallType: true`：
那时「忘了标」会静默走完语义匹配，和「标成 embedding」的后果完全不同。

**`noStore` 生效时写入的三条路全堵死**：`prepareWrite()` 和 `prepareTicket()` 拒发票据，
而 `write()` / `writeMany()` 不带票据时会自己再查一次策略 —— 不是「这次不写」，是写不进去。
（`write` 的票据是可选的，只堵前两条等于留了一扇正门。）主流框架这一层都是"调用方自觉"。

信号从 `prompt.context` 读。默认实现**不内置任何关键词** —— 「现在/今天/最新」那类
词表漏一条就是持续的错答案，中英文还各要一份。要加词表或分类器，自己写一个
`CachePolicy`，用 `combinePolicies` 串上去（`noCache` / `noStore` 各自取第一个理由，
TTL 取最短）。

## 上线前：判别力自检

```ts
import { checkPairEncoder, assertDiscriminates } from "@jolli.ai/semantic-cache";

const report = await checkPairEncoder(pairEncoder, [
  { label: "该命中", a: "什么是过拟合？", b: "过拟合是什么意思？", shouldMatch: true },
  { label: "不该命中", a: "什么是过拟合？", b: "什么是欠拟合？",   shouldMatch: false },
]);
assertDiscriminates(report);   // 分不开就抛，别让任务错配的模型上线
```

`margin = 正例最低分 − 负例最高分`。大于 0 才说明两组可分。
**把它放进 CI**：这是唯一能在上线前抓到任务错配的手段，十分钟的事。

### 探针从上传的资料自动生成

手写探针在产品里不成立 —— 老师传什么、学生问什么都事先不知道。但资料上传的那一刻
语料就在手上了：

```ts
import { generateProbes, checkPairEncoder } from "@jolli.ai/semantic-cache";

const report = await generateProbes(uploadedDocs, {
  phrasing: async (concept, n) => askYourLLM(concept, n),   // 可选，产品已有 LLM 就接上
});
if (!report.usableFor.positives) { /* 只能检出假命中，检不出合法复用被误拒 */ }
await checkPairEncoder(encoder, report.probes);
// report.calibratedOn 直接填进 Calibrated.calibratedOn
```

探针按难度分四档：`identical`（逐字相同，天花板检查）、`paraphrase`（同一概念的不同
问法）、`sibling`（**同一单元内**的不同概念 —— 难负例）、`distant`（跨单元，容易负例）。

分档不是装饰：`L1 正则化` 与 `L2 正则化` 词汇几乎全重叠、意思不同，双编码器本来就
分不开。混在一起算总 margin 会被容易那批撑得虚宽，把真正会造成假命中的那一档盖掉。

**没有改写来源时不造正例**（模板造的「不同问法」字面上几乎相同，任何编码器都能过），
**取样按内容哈希稳定**（同一批资料跑两次必须得到同一组探针）。

**别用「分数跨度」代替 margin。** 跨度只看最大值减最小值，一个把「完全无关」打得比
「同义改写」还高的打分器（顺序整个反过来、毫无用处）只要分数摊得开就能过关。
验证台先前就是这么判的，`test/Discrimination.test.ts` 里留着那个反例。

### 阈值就从这批探针里来

行业通行做法是从生产日志抽 100–500 条真实请求人工标注、画 precision/recall 曲线定阈值。
**那套假设的是单一语料、单一部署，而且那份语料稳定到值得请人标一遍。** 语料由终端用户
上传、且一批一个样的时候，这两条都不成立：没有可标的历史日志，也没有「一次标完管很久」
的前提。可用的只有一件事 —— **语料本身就在手上**：

```ts
import { generateProbes, checkPairEncoder, assertDiscriminates, suggestThreshold } from "@jolli.ai/semantic-cache";

const probes = await generateProbes(docs, { phrasing: askYourLlm });
const report = await checkPairEncoder(pairEncoder, probes.probes);
assertDiscriminates(report);                      // 分不开就别往下走，标什么都是标一个常数

const picked = suggestThreshold(report, { corpus: `kb-${kbId} · v${version}` });
if (picked.threshold === null) { /* 见下面两条降级 */ }

const cache = createSemanticCache({
  recall: { scorer: pairEncoder, thresholds: { floor: picked.threshold }, calibratedOn: picked.calibratedOn },
  // …
});
```

判据和 [`FINDINGS.md`](../FINDINGS.md) 的口径一致：**在正命中率 ≥ 95%（默认，可调）的
前提下取命中率最高的那个 θ**。假命中是贵的那一侧（返回错答案），漏命中只是白花一次
生成 —— 取舍写进 `calibratedOn`，事后看得见。两组完全分得开时 θ 落在空隙中点，
不贴着正例最低分放：探针只有几十条，真实流量迟早会把空隙填上一些。

**标不出来就别上线。** `threshold` 为 `null` 时 `calibratedOn` 是**空串** —— 顺手填进
`Calibrated` 会在构造期抛，一次失败的标定不可能被带上线。两种失败各有各的意思：

| 失败 | 意思 | 怎么办 |
|---|---|---|
| 一条正例都没有 | 没接 `phrasing`，也没有用户提供的问法。负例两两配对就有，**正例没有来源就是没有** | 接上 `phrasing`，或收集真实问法 |
| 达不到目标正命中率 | 这批语料里有一对概念，这个打分器分不开（`hardestNegative` 点名是哪一对） | 换打分器；或这批语料退回 ② 精确匹配（零假命中风险，只是命中率低）；或先开影子模式攒流量 |

**分组与触发时机是业务层的事。** 库只认「一批探针 + 一个 `corpus` 标签」：这批探针
对应哪一批语料、多久重跑、要不要按批分别建缓存实例，都由你决定 —— 阈值绑在构造期是
有意的（运行时改阈值等于让它脱离标定），所以要按批隔离就按批建实例：store、编码器、
retriever 全共享，实例本身只是个闭包，几乎不要钱。

## 测试

```bash
node --experimental-strip-types example/Smoke.ts   # 端到端冒烟，失败退非 0
npm run test                                       # node:test，零依赖，不下载模型
npm install && npm run typecheck                   # tsc 要装，其余都不用
```

单测守的是**出错也不报错**的那些不变式：票据配错 prompt、没有依据的答案不写入、
③ 拿回候选后要复核 scope、替换先写后删、判别力判据是 margin（不是分数跨度）、
标不出阈值时 `calibratedOn` 是空串因而带不上线。每一条都对应
[`../FINDINGS.md`](../FINDINGS.md#踩过的坑) 里的一个坑 —— 散文守不住它们，
一行实现改错了不会有任何东西变红。

## 离线标定与 A/B

```ts
import { evaluate, compare } from "@jolli.ai/semantic-cache";

const withRerank = await evaluate(cacheWithRerank, scenarios, generate, hooks);
const without    = await evaluate(cacheWithoutRerank, scenarios, generate, hooks);
compare(withRerank, without).falseHitDelta;  // ④ 这道闸的价值
```

两条约定：

- **判据是「答案的首要依据是不是那篇资料」，不是「有没有复用」。**
  缓存里有真实规模的历史条目之后，探测问题可能命中另一条**内容正确**的缓存 —— 那是成功。
  而且必须落在**首要依据**上：只要期望文档出现在 top-k 里就算过，
  会把「复用了过拟合的答案给问欠拟合的学生」判成通过。
- **`hooks.warm` 要灌真实规模的干扰缓存。** 不灌的话召回永远只有 1 条候选。

**有生产日志的时候**，行业做法仍然更准：抽 100–500 条真实请求人工标注、画
precision/recall 曲线、precision ≥ 95% 再放量、shadow mode 先行。没有日志可标时走
上面的「阈值就从这批探针里来」—— 两条路的判据是同一个，只是证据来源不同。
**没有任何一条路的终点是「用别人语料上标出来的默认值」。**

## 容量淘汰

```ts
createPgVectorCacheStore({ ..., eviction: { policy: "fifo", capacity: 10000 } });
// policy: "fifo" | "rr" | "lru" | "lfu"
```

**容量是每 scope 的，不是全库。** 召回是 scope 内的（③ 的 pre-filter），所以「太多」
是 scope 内的概念；按全库设上限会让热门 scope 挤掉冷门 scope 的全部条目 ——
那是多租户里最难查的一类问题。

| 策略 | 排序依据 | 命中时要记账吗 |
|---|---|---|
| `fifo` | 写入时间（本来就存着） | **不要** |
| `rr` | 随机 | **不要** |
| `lru` | 最近使用时间 | **要** —— 每次命中一次写 |
| `lfu` | 使用次数（同次数退到 LRU） | **要** |

**`lru`/`lfu` 会把命中路径变成写路径**，而命中越多写越多 —— 命中多正是这东西
起作用的时候。所以推荐从 `fifo` 起步：它拿已有的 `createdAt` 排序，零额外成本，
对「问题分布随时间漂移」这个语义缓存的主要失效模式已经够用。

`touch()` 在 `fifo`/`rr` 下是**真正的空操作**（连一次往返都不发），所以 SDK 无条件
调它，策略知识留在存储里。三个后端的四种策略跑同一份判据
（`lab/scripts/storeConformance.ts`），必须给出同一批留存 id。

**LFU 的固有代价写成了判据**：新条目 `useCount=0`，很容易被立刻淘汰。次数封顶
1023（Redis 自己的 LFU 用 8 位对数计数器，理由一样）—— 不封顶的话早期攒够次数的
老条目永远赖着不走。

## 运行指标

```ts
import { createMetrics } from "@jolli.ai/semantic-cache";

const metrics = createMetrics({ costPerGeneration: 0.0075 });
const t0 = Date.now();
const result = await cache.resolve(prompt, generate);
metrics.record({ result, ms: Date.now() - t0, segment: prompt.context.courseId });

metrics.snapshot();
// { requests, attempted, hits, misses, hitRate, byOutcome, missedAtGate,
//   bypassedByReason,
//   shadow: { requests, wouldReuse, wouldReuseRate },
//   evictions: { total, bySourceVersion },  ← 只数真删掉的
//   latencyMs: { hit, miss, bypassed }, saved, bySegment }
```

**命中率的分母是 `attempted`（真的查了缓存的那些），不是 `requests`。**
`requests = hits + misses + byOutcome.bypassed`，`misses` 只数「查了但没命中」。
绕开的请求一道闸都没跑，算进分母的话，一个策略绕开了大半流量的部署在看板上就长得像
「一个什么都命中不了的缓存」—— 那正是下面 `bypassedByReason` 要防的误读。延迟同理分三档：
未命中付的是召回 + 精排 + 检索 + 生成，绕开只付生成，混在一起会把未命中报便宜。

**`evictions` 数的是「真删掉了几条」，不是「判负了几次」。** 两者刻意不同源：
影子模式下 ⑤ 判负一律不删（评估不该改变被评估的东西），要是从 `verdict === "exit"`
反推，看板会报出一批根本没发生的驱逐，把「这次运行没改变缓存状态」这条不变量从最
可信的那一侧打穿。判负次数看 `missedAtGate[5]`，删除次数看 `evictions`。

**一个明确的缺口：现在没有「离翻车多远」那组数。** 先前 ⑥ 每次命中都会算一个支撑度，
于是有 `headroomP10` / `midBandRate` 这类**比命中率更早报警**的信号（分布整体上漂时，
越线的更多 → 命中率升、假命中也升，只看命中率会以为一切在变好）。⑥ 移除后这组数
没有了。现在最接近的替代是影子模式加 `missedAtGate`；③④ 的分数逐次写在 `trace` 里，
但 `Metrics` 不聚合它们 —— 想要问题侧的同类信号，得自己从 trace 收。

## 影子模式：上线前先在真实流量上跑判定

```ts
createSemanticCache({ /* … */, shadow: true });
```

闸照常全跑、真未命中照常写入（缓存要暖得起来），但**从不复用** —— 每次都真生成，
真实判定放在 `CacheResult.wouldReuse` / `LookupResult.wouldHave` 里，配
`metrics.snapshot().shadow.wouldReuseRate` 看「真开了能命中多少」。它不进
`hits` / `hitRate`：那两个数记的是实际发生的事，而实际发生的是一次生成。

读路径在影子模式下**严格只读**：不驱逐、不 touch、被降级的命中不写回。
⑤ 判负是破坏性的，而影子模式的目的恰恰是检验它判得对不对 ——
一边评估一边按评估结果删数据，等于用没验证过的判据毁掉证据。

从 lab 的标注场景集到生产之间，这是中间那一步：**场景集证明机制成立，
影子模式证明它在你的流量上成立。**

`byOutcome` 里 **`bypassed` 单独成一档**，配 `bypassedByReason` 按理由分组。并进
`generated` 的话，一次策略绕开和一次「查了但没命中」在看板上完全一样，于是「上游
某个信号一直是开的」只表现为命中率下降，查不出原因 —— 那正是主流框架里静默 no-op
的病根。`missedAtGate` 不含绕开：它一道闸都没跑。

零依赖，不碰时钟/网络/存储 —— 只吃 `CacheResult`，时间和分段键由你给。

对齐 Redis LangCache 看板那一组（请求/命中/未命中、命中率、延迟、token 节省、
分段命中率），再加它给不出的一组：**未命中时被哪道闸拦下**。单阈值缓存只有
「命中/未命中」，这里能说出是问题侧不像（③④）还是资料改版了（⑤）——
两种未命中的处置完全不同：前者调阈值或换打分器，后者说明缓存正在按预期失效。

**刻意不算正命中率与正确拒绝率。** 那两个要标签（复用的那次答案到底对不对），
线上没有这个信息。LangCache 的看板同样不给，他们用 LLM-as-a-judge 抽样补。
想要这两个数走 `evaluate()` 的标注集，或对线上流量抽样人工判 ——
把一个需要标签的数摆在只有计数的看板上，等于请人误读。

## 并发

正常用法是被 web backend 并发调用。要点：**不会坏数据**；同一个问题的并发请求
进程内合流（默认开）；**跨进程并发未命中会产生重复条目** —— 浪费而非错误，
`getByHash` 保证返回确定的那一条，多余的行由 TTL 与 `purgeExpired()` 收。

写自己的 `CacheStore` 之前先读 [`DESIGN.md` 的并发一节](DESIGN.md#并发)，
那里有三条对存储实现的硬要求。

## 边界

这个库**不适合**所有场景，也有已知拿不到的东西。上线前先读
[`DESIGN.md` 的「诚实的边界」](DESIGN.md#诚实的边界)。
