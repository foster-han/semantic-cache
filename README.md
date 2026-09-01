# semcache

分层语义缓存：把「问的是不是同一件事」和「那个旧答案现在还立得住吗」拆成六道各管一类
失效的闸，而不是一个相似度阈值一刀切。

```
sdk/    @jolli.ai/semantic-cache —— 零依赖 TypeScript 库。
        存储、检索、打分、生成都由你传进来，所以能接进已有的 RAG 应用
lab/    本地验证台 —— 带标注的场景集 + 对照实验 + 模型判别力自检，可离线跑
docs/   《语义缓存的精度层》文章源文件
```

## 装与跑

```bash
cd lab && npm install
npm start            # 中文语料，真模型（首次下载约 300MB）→ http://localhost:7788
npm run stub         # 零依赖秒起，但分数没有统计意义
```

存储默认走内存，换后端只是一个环境变量：

```bash
createdb semcache && psql -d semcache -c 'CREATE EXTENSION vector'
npm run start:pg                     # pgvector
npm run start:redis                  # Redis 8（vectorset 是内核自带的）
npm run store-conformance            # 几种后端必须跑出同样的结果
```

生成默认是拼接片段（不是真生成）。要真 LLM：

```bash
GEN=claude-cli npm start             # 用本机 Claude Code，不需要 API key
```

**四个轴互不相干，随便组合** —— 编码器 `MODE`、语料 `CORPUS_LANG`、存储
`SEMCACHE_DB`/`SEMCACHE_REDIS`、生成端 `GEN`。npm scripts 只是常见组合的快捷方式：

```bash
GEN=claude-cli MODE=local CORPUS_LANG=zh SEMCACHE_REDIS=redis://localhost:6379/2 npm start
```

完整的变量表在 [`lab/README.md`](lab/README.md#配置四个互不相干的轴)。

只想看 SDK 本身：

```bash
cd sdk
node --experimental-strip-types example/Smoke.ts   # 端到端冒烟：假模型，不下载任何东西，失败退非 0
npm run test                                       # 单测（node:test，零依赖）
npm install && npm run typecheck                   # 类型检查要 tsc，所以这一步才需要装东西
```

单测覆盖的是那些**出错也不报错**的不变式：⑥ 的 top-1 算子、票据配错 prompt、
没有依据的答案不写入、检索故障不驱逐、中带替换必须先写后删、判别力判据是 margin
而不是跨度。每一条都对应 [`FINDINGS.md`](FINDINGS.md#踩过的坑) 里的一个坑。

## 往下看

| | |
|---|---|
| 怎么用这个库 | [`sdk/README.md`](sdk/README.md) |
| 为什么这么设计 | [`sdk/DESIGN.md`](sdk/DESIGN.md) |
| 验证台怎么用、场景集是什么 | [`lab/README.md`](lab/README.md) |
| 跑出来的结论与踩过的坑 | [`FINDINGS.md`](FINDINGS.md) |
| 完整文章 | [`docs/semantic-cache-precision.html`](docs/semantic-cache-precision.html) |
