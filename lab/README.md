# 验证台

跑一门课的语料与带标注用例，用对照实验检验（或推翻）《语义缓存的精度层》里的论断。
判定逻辑全部来自 `../sdk` —— **跑验证台就是在跑 SDK**，这里不再有第二套实现。

跑出来的数字在 [`../FINDINGS.md`](../FINDINGS.md)。

## 跑起来

```bash
npm install
npm start          # 中文语料 + 真模型（首次约 300MB 下载）→ http://localhost:7788
npm run stub       # 零依赖秒起，但分数没有统计意义
npm run typecheck
```

## 配置：四个互不相干的轴

**编码器、语料、存储、生成端是四件独立的事，随便组合。** npm scripts 只是常见组合的
快捷方式，真正起作用的是环境变量 —— 想要哪种组合，直接拼：

```bash
# 真模型 + 英文语料 + Redis + 真生成
GEN=claude-cli MODE=local CORPUS_LANG=en SEMCACHE_REDIS=redis://localhost:6379/2 npm start

# stub 编码器 + pgvector（跑得快，用来验存储实现，不用来读分数）
MODE=stub SEMCACHE_DB=postgres://postgres:postgres@localhost:5432/semcache npm start
```

### ① 编码器 —— 三个打分器角色

| 变量 | 默认 | 说明 |
|---|---|---|
| `MODE` | `local` | `local` 真模型（ONNX，本地跑）/ `stub` 字符 Jaccard 的哈希投影 |
| `PAIR_MODEL` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | ③ 缓存匹配（问题↔问题） |
| `RETR_MODEL` | `Xenova/multilingual-e5-small` | 检索 + ⑥ 的答案侧编码 |
| `CE_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | ④ 精排。**默认这个是故意留的坏例子**，见下 |

### ② 语料

| 变量 | 默认 | 说明 |
|---|---|---|
| `CORPUS_LANG` | `zh` | `zh` / `en`。同一套场景，两种语言各一份 |

### ③ 存储

**给了连接串就走那个后端，都不给走内存。** 默认内存是硬要求 —— `npm run stub` 得能零依赖秒起。

| 变量 | 默认 | 说明 |
|---|---|---|
| `SEMCACHE_DB` | 无 | Postgres 连接串。设了就走 pgvector |
| `SEMCACHE_REDIS` | 无 | Redis 连接串。要 Redis 8（vectorset 在内核里，不用 Redis Stack） |
| `STORE` | 按上面推断 | `memory` / `pgvector` / `redis`，显式覆盖推断 |
| `SEMCACHE_TABLE` | `semantic_cache_<维度>` | pgvector 表名 |
| `SEMCACHE_NS` | `semcache_<维度>` | Redis key 前缀 |
| `SEMCACHE_ANN` | 无 | `1` 则建近似索引（HNSW）；默认 scope 内精确 KNN |

默认名带上向量维度，是因为 stub 是 256 维、e5-small 是 384 维 ——
不带的话两者会抢同一张表，换 `MODE` 时启动就被维度守卫拦死。

### ④ 生成端

默认 `stub`：把检索到的首个片段换序换壳。**它不是真生成**，⑥ 的支撑度因此天然偏高，
θa 的绝对值在它上面标不准。

| 变量 | 默认 | 说明 |
|---|---|---|
| `GEN` | `stub` | `stub` / `claude-cli` / `deepseek` |
| `GEN_MODEL` | 按后端 | `claude -p --model` 的值；deepseek 默认 `deepseek-v4-flash` |
| `GEN_TIMEOUT_MS` | `120000` | 单次超时 |
| `DEEPSEEK_API_KEY` | 无 | `GEN=deepseek` 必需 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 换兼容端点 |
| `CALIB_SAMPLES` | stub 1 / 其余 3 | `calibrate.ts` 每条用例采样几次（对 DeepSeek 目前是空转，见 FINDINGS） |
| `GEN_MEMO` | `1` | bench 与场景回放对**同输入**只生成一次。`0` 关掉，用来看生成端自身的抖动 |

三个生成端的取舍：

| | 一次耗时 | 完整 bench（416 次） | 要什么 |
|---|---|---|---|
| `stub` | 0 | 秒级 | 什么都不要，但**不是真生成** |
| `claude-cli` | ~8.5 秒 | 一个多小时，**跑不动** | 本机 Claude Code，不用 API key |
| `deepseek` | **~1 秒** | **~15 分钟，跑得动** | `DEEPSEEK_API_KEY` |

Codex 用户注意：若你的 Codex 已经配好 DeepSeek，key 可以直接取出来 ——

```bash
export DEEPSEEK_API_KEY=$(grep -oP 'experimental_bearer_token\s*=\s*"\K[^"]+' ~/.codex/config.toml)
GEN=deepseek MODE=local npm start
```

`claude-cli` 约 8.5 秒一次，够用来重新标定和手动/场景验证；**完整 bench 跑不动**
（13 场景 × 30 条干扰 ≈ 416 次 ≈ 1 小时），所以页面上会把对照实验卡禁掉。
生成失败直接抛错，**不退回 stub** —— 两种分布混着标出来的 θa 比标不准更糟。

### ⑤ 阈值：来自标定表，不是硬编码

四个阈值由 [`Calibrations.ts`](Calibrations.ts) 按 **(语料 × 编码器 × 生成端)** 给出 ——
它们随这三者而变，一份通用默认值就是把某个组合上标出来的数当成普适值。启动日志和页面
横幅会写明这次用的是哪一行、有没有借用或被覆盖。

**没有标定过的组合不会假装有**：借最近的一行并说清楚借的是谁。特别地，
`thetaQ` 可以是「无」—— 中文语料 + 默认重排器 `ms-marco` 就是这种情况（它在中文上饱和，
跨度 0.0013），此时 **④ 这道闸默认关掉**。给它填个占位数字只会得到一道恒放行的假闸：
页面上看着在工作，实际什么都不拦，而「④ 值不值」那张对照卡会永远输出「两边一模一样」。

要自己指定就用环境变量（会盖掉表里那一行，并在页面上标出来）：

| 变量 | 说明 |
|---|---|
| `RECALL_FLOOR` | ③ 召回下限（句对模型余弦尺度） |
| `THETA_Q` | ④ 精排闸值（重排器自己的尺度）。`none` = 明确表示没有这道闸 |
| `THETA_A_HI` / `THETA_A_LO` | ⑥ 支撑度两档（检索模型 passage 空间） |

```bash
# 换一个句对相似度模型，标定后把 θq 显式带上
CE_MODEL=cross-encoder/quora-distilroberta-base THETA_Q=0.62 npm start
```

### 其他

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `7788` | 监听端口 |
| `ALLOW_ENCODER_FALLBACK` | 无 | `1` 才允许编码器降级（检索模型加载失败退回句对模型、本地模型不可用退回 stub）。**默认直接抛错** —— 降级之后的分数是另一个分布上的产物，比跑不起来更难发现 |

## 验证脚本

```bash
npm run compare-stores      # 同一份场景集，两种存储后端的结论必须逐行一致
npm run store-conformance   # 直接对着 InspectableCacheStore 的十个方法比可观察结果
node --experimental-strip-types scripts/calibrate.ts   # 标定 θq / θa，认 GEN=
```

前两个要两种后端都在（默认内存 + pgvector；`:redis` 后缀换成 Redis）。
`compare-stores` 只走 `resolve` 那条路，`getById`、`evictBySource`、`clearScope`、
`purgeExpired` 碰不到，所以才有第二个。

**标定要用 `calibrate.ts` 的探针，不要用 bench** —— 13 条场景集的支撑度分布太两极，
分不出几组阈值的差别。

## 页面从上到下就是使用顺序

1. **重排器自检** —— 先跑。判据是 **margin（正例最低 − 负例最高）< 0.15 即任务错配**，
   不是分数跨度：跨度大但顺序反的模型毫无用处。自检的结论会回头标注 ④ 那张实验卡
   （不可用 / θq 落在负例之下 / 没有标定过的 θq，三种情形各有各的读法）。
2. **对照实验** —— 每张卡自动跑两遍完整场景集，并排显示假命中数并生成结论。
   其中「脱敏声明这道防线」那张的 B 侧**预期会被拒绝** —— 声明已脱敏却落进共享 scope
   是构造上必然出错的组合，SDK 在写入前就抛错，而不是等 ⑥ 去兜。卡片把这算作通过。
3. **单条场景细看** —— 逐闸判定与分数。跑在自己的缓存上，不影响手动探索。
4. **手动探索** —— 自己出题、改开关、调阈值。结果显示在这一区里。

**只有「清空缓存」按钮会清手动探索的缓存。** 对照实验和场景回放各跑在隔离的缓存上。

## 场景（一门课 ML101，26 条）

老师上传本学期资料，学生针对这门课提问。**没有跨课程问答**——一个学生只在一门课里。

| 类别 | 用例 | 期望拦截 |
|---|---|---|
| 同义改写 ×10 | 过拟合 / 学习率 / 交叉验证 / 偏差方差 / 归一化 / 剪枝 / 早停 / F1 / 损失函数 / 集成 | 应复用 |
| 近义反义 ×7 | 过拟合-欠拟合 / 精确率-召回率 / L1-L2 / 准确率-精确率 / 早停-剪枝 / 决策树-集成 / 归一化-编码 | ③④ |
| 同词不同指 ×2 | 归一化（特征缩放 vs 批归一化）、收敛（优化 vs EM） | ⑥ |
| 实体塌陷 ×4 | Hinton-LeCun / Vapnik-Breiman / Hinton-Vapnik / LeCun-Breiman | ⑥ |
| 语料改版 ×2 | 老师改大纲：期中范围、评分构成 | ⑤ |
| 对照组 ×1 | 两个远主题 | ③④ |

另有 30 条干扰缓存，跑用例前先灌进去 —— 不灌的话召回永远只有 1 条候选，④ 没有候选可排。

**干扰缓存每个场景都要重灌，输入一字不差**，所以一次 bench 的 832 次生成里
只有 73 个不同输入。`GEN_MEMO`（默认开）把重复的那 91% 去掉，真生成下
一次完整 A/B 从半小时变成 4 分钟。判定结果完全一致。

标定集另有 42 条（该复用 19 + 该拦下 23），覆盖 19 篇讲义，见 `scripts/calibrate.ts`。
近义对只挑**住在不同文档里**的概念 —— L1/L2 都在 n8、precision/recall 都在 n11，
`sourceIds[0]` 判据看不出错，那是已知盲区。

**个人成绩不在语料里。**「李四的作业二得了多少分」是结构化查询 + 授权检查，
应由意图路由送去工具，不该进 RAG 与缓存。实体塌陷的合法载体是**学科内容里的人名**。
