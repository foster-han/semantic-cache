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

这里所有文件都只有句对，**没有资料、没有资料版本**，所以只够测 ②③④ 的问题侧判断。
⑤ 版本比对和 ⑥ 回答校验要「答案 ↔ 资料片段」，那两道闸的标定仍然留在课程语料上
（`scripts/calibrate.ts`）。④ 的**问↔答**形态同样需要答案文本，QQP 也给不了 ——
候选数据源见 FINDINGS 的待办。

## 许可

- `langcache-*.json` —— `redis/langcache-sentencepairs-v1`，**Apache-2.0**，可随源码分发。
  但它是多个上游语料的合集（QQP / PAWS / MRPC / PIT-2015 / SICK / STS-B …），
  各上游自己的条款仍然适用。
- `qqp.json` —— Quora Question Pairs 经 GLUE 分发，用于研究用途。

派生指标（命中率、正命中率、正确拒绝率那些）都可以自由引用；
如果这个仓库要对外发布，确认一下再随源码一起分发原始句子。
