# `lab/data/`

跑分用的固定数据。**这里的文件是钉住的，不是缓存** —— [`FINDINGS.md`](../../FINDINGS.md)
里每个数字都基于这里某一份的**那一次快照**，重新取一份就复现不出来了
（`datasets-server` 的分页顺序不保证跨时间稳定，而且这些脚本按顺序截断取样）。

## `qqp.json`

| | |
|---|---|
| 来源 | `nyu-mll/glue` · config `qqp` · split `validation`（Quora Question Pairs） |
| 取法 | `scripts/fetchQqp.ts`，扫过 1500 行取出 1000 对 |
| 规模 | 1000 对：该命中 500 / 该未命中 500 |
| 标签 | `1` = 语义等价、该命中；`0` = 不等价、该未命中 |

**`balanced: true` 是这份数据最要紧的一条元信息。** QQP 原始正例率约 37%，这份被均衡到
50%。两类指标对正例率的依赖方向相反：

- 命中率、正确拒绝 —— 各自只看一个标签的分母，**不受影响**
- 正命中率（precision）—— 分母混了两类，**正例率越高越好看**

所以拿这里的 precision 跟别人公布的数字对照时，先确认两边的正例率。要无偏的那份：
`QQP_BALANCE=0 node --experimental-strip-types scripts/fetchQqp.ts 1000`（会覆盖此文件，
先备份 —— 覆盖之后 FINDINGS 里的数字就对不上了）。

## `langcache-*.json`

来自 [`redis/langcache-sentencepairs-v1`](https://huggingface.co/datasets/redis/langcache-sentencepairs-v1)
（Apache-2.0，Redis 为语义缓存做的合集），`scripts/fetchPairs.ts <config> [条数]` 取的。
**全部保留原始正例率**，没做均衡 —— 这几份是用来验证的，要无偏的那个数。

| 文件 | config | 对数 | 原始正例率 | 取样 | 它补 QQP 的什么 |
|---|---|---|---|---|---|
| `langcache-paws.json` | `paws` | 800 | 48.9% | 撒页 | **对抗性高词汇重叠** —— 实体互换、词序调换（`Shi Le died, Shi Hu seized power` ／ `Shi Hu died, Shi Le seized power`，标签 0）。④ 在流水线里真正会面对的那类负例 |
| `langcache-pit2015.json` | `pit2015` | 800 | **18.8%** | 顺序全取（只有 972 行） | Twitter 短文本：噪声、口语、不完整句。而且正例率最低 —— **最接近真实缓存的重复率** |
| `langcache-all.json` | `all` | 795 | 48.6% | 撒页 | 多来源混合。实际拿到 paws 200 / qqp 300 / apt 31 / stsb 64 / sick 200 |
| `langcache-qqp.json` | `qqp` | 800 | 36.5% | 撒页 | 和 `qqp.json` 同源但**保留原始比例**，所以能量出「均衡到 50%」让 precision 偏乐观多少 |

**取样那一列不是装饰。**`all` config 按 source 分块排列，顺序取前 800 行拿到的 800 对
**逐条等于 `paws` 那一份** —— 一份自称多来源混合的数据其实是另一份的副本，而这件事是靠
「两份数据的指标一模一样」才发现的。所以 `fetchPairs.ts` 改成按固定 seed 跨 split 撒页，
并把实际拿到的 `sources` 写进文件。想换一份样本：`SAMPLE_SEED=<n>`。

正例率本身是这几份数据的第三个变量（18.8%~48.9%）。**全放行的正命中率就等于正例率**，
所以「正命中率 ≥ 90%」这个门槛在 pit2015（18.8%）上很苛刻、在 paws（48.9%）上宽松些 ——
跨数据集比 precision 之前先看基线。`ProbeMetrics.bestHitAtPrecision` 会在门槛低于基线时
返回 `baseline-already-passes` 而不给数字。

## `vcache-*.json`

来自 [vCache](https://github.com/vcache-project/vCache)（Berkeley，*Reliable and Efficient
Semantic Prompt Caching*）的四份基准，**Apache-2.0**，`scripts/fetchVCache.ts <基准> [条数]` 取的。

上面那几份是句对，只答得了「两句话像不像」。这几份多出**等价组标注**，于是第一次答得了
另一个问题：**复用的那个答案对不对**。判据不是我们定的，是 vCache 自己 `benchmark.py` 里的：

```python
label_id_set = data_entry.get("id_set", -1) or data_entry.get("ID_Set", -1)
cache_response_correct = label_id_set == response_metadata.id_set
```

命中一条不同 label 的条目就是假命中 —— 验证台指标区那句「这里没有『正命中率』：那要知道
复用的答案对不对，线上没有这个信息」，在这两份数据上不成立。

| 文件 | 基准 | 上游行数 | 取样 | 等价组 | 同组对数 | 它补 QQP 的什么 |
|---|---|---|---|---|---|---|
| `vcache-lmarena.json` | `SemBenchmarkLmArena` | 51,147 | 2,000 | 1,491（最大 4，47% 的行有伙伴） | **602** | LM Arena 真实聊天 prompt，**带 gpt-4o-mini 的真答案和真生成耗时**（中位 2.43s／均值 3.63s／最长 177s）—— 「省下的生成」从计数变成秒数 |
| `vcache-search.json` | `SemBenchmarkSearchQueries` | 150,000 | 4,000 | 3,538（最大 5，21% 的行有伙伴） | **557** | 真实浏览器搜索查询。**另有 `cluster` 一列**（`id_set` 的前缀，粗一档）给出 352 对「话题挨着但不等价」的近似负例 |

`SemBenchmarkClassification`（37,836 行）与 `SemBenchmarkCombo`（27,500 行）脚本也支持，还没取。
前者**没有等价组列**，判据只能落回比答案字符串；后者的 `ID_Set` 会取负值，README 说那是
「不该命中」的条目，但 `benchmark.py` 只把 `-1` 当缺失、其余照常做等值比较 —— 语义没查实，
脚本因此不把负 label 当等价组统计，只记个数。

**取样会把等价组打散，这是这份数据独有的坑。** lmarena 平均 14.6 条/组散在 51,147 行里，
撒页抽 N 行的同组对数约 `C(N,2)×13.6/51147` —— 抽太少就一对正例都没有，而脚本本来会
照常成功写盘。所以：**同组对数为 0 就抛错不落盘**，低于 50 对时按当前组密度算出「要到
50 对大约需要多少行」。同组对数随条数**平方**增长，补起来比直觉便宜。

**`vcache-search.json` 的标签是搜索日志聚出来的，不是人判的**，实测有明显噪声：同一个
`id_set` 里出现过 `bank of america routing number mn` 与 `bank of america new mexico routing
number`（两个州）、`call of duty black ops 2` 与 `every call of duty game`。拿它算出来的假命中率
是**相对这份标注**的数，不等于人会判错。文件里的 `labelNoise` 字段就是这句话。

它的 `response_*` 列也不是答案，整列都是 `Not required for the benchmark because of the id_set`
这句占位串（`responsesArePlaceholders` 记着数），所以这一份用 `VCACHE_RESP=none` 取，
`responsesOmitted` 记下丢了哪列、为什么 —— **不记这一行，一份 `RESP=none` 的文件看起来
就跟「这份基准本来就没有答案」一模一样**，而那两件事对 ④ 的问↔答形态是完全不同的处境。

**预算好的向量默认不留。** 上游给了 6 组（`text-embedding-3-large/small`、
`Alibaba-NLP/gte-large-en-v1.5`、`intfloat/e5-large-v2`，后两个还各有一个微调版 ——
就是 vCache 里 `BerkeleyEmbedding` 那个基线）。它们对 ④ 一列都用不上（cross-encoder 要的是
两段文本拼起来，没有「各自编码再比」这一步），但**对 ③ 六列全用得上**：`PairEncoder`
是注入的，lab 可以实现成一张查表，一个模型都不加载就把 ③ 的编码器横评从 n=26 抬到 n=51k。

要用就 `VCACHE_EMB=gte,e5_large_v2`，代价是每行约 11 KB。注意 **gte / e5 那四列上游没有
归一化**（范数 21~23，OpenAI 那两列才是 1.0），而 `PairEncoder` 的契约是归一化向量 ——
不归一化不报错，只是量在另一个尺度上，`recallFloor` 那个阈值随即失配。脚本**入库时归一化，
并把原始范数区间写进 `embeddings.<列>.rawNormRange`**，动过什么是可查的。

取样也和 `fetchPairs.ts` 有一处不同：**退避阶梯长得多**（3/10/30/60/120 秒，认 `Retry-After`，
成功也歇 1.2s）。那套 2/4/8/16 秒共 30 秒的扛不住 datasets-server 的按分钟限流 ——
实测连拉三十页后一路 429，整轮白跑。有 `HF_TOKEN` 就设上，额度高得多。

## `scores.json`

每个 (打分器 × 数据集) 的**原始分数与耗时**，`scripts/scorePairs.ts` 写的。
FINDINGS 里那几张表（基线对比、③ 编码器横评、性能）全是从这一份算出来的 ——
分析是纯计算，`benchPairs.ts` 与 `compareBaselines.ts` 都只读它、秒级跑完，
不碰模型。**所以它和上面那些数据文件一样是凭据，不是缓存**：重算一遍要跑九个模型。

复用**按 (模型 id × pooling) 认，不按 key 认** —— 加一个候选只算那一个，
`RESCORE=1` 才全部重算。这条规矩是撞出来的：`semcache-pair` 这个 key 曾经
挂着 `paraphrase-multilingual-MiniLM-L12-v2` 的分数，而 `Models.ts` 的默认早已
换成 `all-MiniLM-L6-v2`，于是 FINDINGS 里标着「③ 现在的默认」的四列量的是上一个模型。

数据文件换了（标签不同）也不会复用 —— 那等于把两轮取样混进同一张表。

跑分：`scripts/scorePairs.ts` 算分存盘（只算缺的），
`scripts/benchPairs.ts` 与 `scripts/compareBaselines.ts` 读盘出表。

## 它补不上什么

`langcache-*` 和 `qqp.json` 只有句对，**没有答案**，所以只够测 ②③④ 的问题侧判断。
④ 的**问↔答**形态需要答案文本，QQP 给不了。

`vcache-*` 把答案和等价组都补上了。**它补不上的是「同一个问题、资料改版后答案变了」**
—— 那四份基准里没有这种条目。⑤ 资料版本比对已于 2026-09 从 SDK 移除，所以这一条
眼下不是缺口；但「答案会随时间失效」这件事本身没有消失，真要再测它，候选是
FreshQA / RealTimeQA / StreamingQA / Time-Sensitive-QA，都还没接。

## 许可

- `langcache-*.json` —— `redis/langcache-sentencepairs-v1`，**Apache-2.0**，可随源码分发。
  但它是多个上游语料的合集（QQP / PAWS / MRPC / PIT-2015 / SICK / STS-B …），
  各上游自己的条款仍然适用。
- `qqp.json` —— Quora Question Pairs 经 GLUE 分发，用于研究用途。
- `vcache-*.json` —— HF 上四个数据集仓库都标着 **Apache-2.0**。但**上游成分各自另有条款**：
  lmarena 那份的 prompt 来自 LM Arena 的对话日志，search 那份来自搜索日志，答案是
  OpenAI / Meta 模型生成的。要对外分发原始文本之前，这几层都得各自确认一遍 ——
  仓库标一个 Apache-2.0 不代表里面每一句话都是。

派生指标（命中率、正命中率、正确拒绝率那些）都可以自由引用；
如果这个仓库要对外发布，确认一下再随源码一起分发原始句子。
