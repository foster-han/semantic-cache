# `lab/data/`

跑分用的固定数据。**这里的文件是钉住的，不是缓存** —— [`FINDINGS.md`](../../FINDINGS.md)
「QQP 实测」那一节的每个数字都基于 `qqp.json` 这一份，换一份就复现不出来。

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

## 它补不上什么

QQP 只有问题对，**没有资料、没有资料版本**，所以只够测 ②③④ 的问题侧判断。
⑤ 版本比对和 ⑥ 回答校验要「答案 ↔ 资料片段」，那两道闸的标定仍然留在课程语料上
（`scripts/calibrate.ts`）。④ 的**问↔答**形态同样需要答案文本，QQP 也给不了 ——
候选数据源见 FINDINGS 的待办。

## 许可

Quora Question Pairs 经 GLUE 分发，用于研究用途。派生指标可自由引用；
如果这个仓库要对外发布，确认一下再随源码一起分发原始问句。
