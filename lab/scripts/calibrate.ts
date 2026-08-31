/** 语言无关的标定：① 重排器判别力 ② ⑥ 支撑度阈值 ③ 检索 top-1 命中率 */
import { createEncoders, cosine } from "../Models.ts";
import { compose as composeAnswer, DOCS, LANGUAGE, RERANK_PROBES } from "../Corpus.ts";
import { createGenerator } from "../Generators.ts";
import type { CourseDoc } from "../types/Corpus.ts";
const enc = await createEncoders();
const byId = (id: string): CourseDoc => {
	const doc = DOCS.find(d => d.id === id);
	if (!doc) throw new Error(`标定用例引用了不存在的文档：${id}`);
	return doc;
};

/**
 * **标定必须和运行路径用同一个生成端。** 分叉过一次，代价是英文语料下阈值高过了
 * 支撑度天花板，任何条目都无法直接复用。
 *
 * 所以这里走的是 Generators.ts 那个接口：默认 stub（换序换壳，支撑度天然偏高），
 * `GEN=claude-cli` 换真生成。**θa 只在标定它的那个生成端上有效** —— 换了生成端
 * 不重标，标出来的数就是别人分布上的产物。
 */
const generator = createGenerator();

/**
 * **随机生成端必须多采样。** 实测 DeepSeek 连跑五轮，margin 在 0.0041~0.0368 之间摆，
 * 差了近 9 倍 —— 单轮结果测的是采样噪声，不是分布。stub 是确定性的，1 次就够。
 */
const SAMPLES = Number(process.env.CALIB_SAMPLES ?? (generator.kind === "stub" ? 1 : 3));

const answerCache = new Map<string, string>();
async function compose(d: CourseDoc, sample = 0): Promise<string> {
  const key = `${d.id}#${sample}`;
  const cached = answerCache.get(key);
	if (cached !== undefined) return cached;
  if (generator.kind === "stub") {
    const text = composeAnswer([d]);
    answerCache.set(key, text);
    return text;
  }
  // 真生成要有问题可答 —— 用文档标题构成学生会问的那句话
  const q = LANGUAGE === "en" ? `What is ${d.title}?` : `${d.title}是什么？`;
  const payload = await generator.generate(
    { matchText: q, retrievalText: q, context: {} },
    [{ id: d.id, text: d.text, score: 1 }],
    sample,
  );
  const text = payload.kind === "answer" ? payload.answer : "";
  answerCache.set(key, text);
  return text;
}

const median = (xs: ReadonlyArray<number>): number => {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * 探针取自语料包（`RERANK_PROBES`）—— 和验证台页面上那个自检**同一份**。
 * 先前这里自带一套写死的问句，于是「页面说可用」和「标定脚本说可用」测的不是同一件事。
 */
const PROBES = RERANK_PROBES.map(p => [p.label, p.a, p.b, p.shouldMatch]);

console.log(`\n== 语言 ${LANGUAGE} ==\n`);
console.log("① 重排器判别力（问题↔问题）");
const rr: Array<{ s: number | null; want: boolean }> = [];
for (const [tag, a, b, want] of PROBES) {
  const s = await enc.rerank(String(a), String(b));
  rr.push({ s, want: Boolean(want) });
  console.log("   ", String(tag).padEnd(28), s === null ? "无重排器" : s.toFixed(4));
}
if (rr[0].s !== null) {
  const scored = rr.filter((r): r is { s: number; want: boolean } => r.s !== null);
  const pos = scored.filter(r => r.want).map(r => r.s), neg = scored.filter(r => !r.want).map(r => r.s);
  const margin = Math.min(...pos) - Math.max(...neg);
  console.log(`    → 正例最低 ${Math.min(...pos).toFixed(4)} | 负例最高 ${Math.max(...neg).toFixed(4)} | margin ${margin.toFixed(4)} → ${margin >= 0.15 ? "可用" : "**不可用**"}`);
  if (margin > 0) console.log(`    → 建议 θq ≈ ${((Math.min(...pos) + Math.max(...neg)) / 2).toFixed(3)}`);
}

console.log("\n② 检索 top-1（问题↔段落）");
const qs = LANGUAGE === "en"
  ? [["What is overfitting?","n5"],["What is underfitting?","n6"],["What is precision?","n11"],["Why do we do k-fold cross-validation?","n13"],["What happens if the learning rate is too large?","n3"]]
  : [["什么是过拟合？","n5"],["什么是欠拟合？","n6"],["精确率是什么？","n11"],["为什么要做 k 折交叉验证？","n13"],["学习率太大会怎么样？","n3"]];
const dv = await enc.embedPassage(DOCS.map(d => d.text));
const qv = await enc.embedQuery(qs.map(q => q[0]));
let hit = 0;
for (let i = 0; i < qs.length; i++) {
  const top = DOCS.map((d, j) => ({ id: d.id, t: d.title, s: cosine(qv[i], dv[j]) })).sort((a,b)=>b.s-a.s)[0];
  const ok = top.id === qs[i][1]; if (ok) hit++;
  console.log("   ", (ok?"ok":"XX"), qs[i][0].slice(0,42).padEnd(44), top.s.toFixed(4), top.t);
}
console.log(`    → top-1 命中 ${hit}/${qs.length}`);

console.log(`\n③ ⑥ 支撑度阈值（答案↔片段，同一 passage 空间）　生成端 ${generator.kind}`);
const spec = [
  /* ---- 该复用：答案就是据这一篇写的 ----
     一篇一条，覆盖全部讲义。先前只有 3 条 —— 而 θa 的每一个结论都压在
     min/中位 上，3 个样本给不出可信的分布位置。 */
  ["该复用", "n1", "n1"],
  ["该复用", "n2", "n2"],
  ["该复用", "n3", "n3"],
  ["该复用", "n4", "n4"],
  ["该复用", "n5", "n5"],
  ["该复用", "n6", "n6"],
  ["该复用", "n7", "n7"],
  ["该复用", "n8", "n8"],
  ["该复用", "n9", "n9"],
  ["该复用", "n10", "n10"],
  ["该复用", "n11", "n11"],
  ["该复用", "n12", "n12"],
  ["该复用", "n13", "n13"],
  ["该复用", "n14", "n14"],
  ["该复用", "n15", "n15"],
  ["该复用", "n16", "n16"],
  ["该复用", "n17", "n17"],
  ["该复用", "n18", "n18"],
  ["该复用", "n19", "n19"],

  /* ---- 该拦下 · 反义或近义，且**住在不同文档里** ----
     同一篇里的两个概念（L1/L2 都在 n8、precision/recall 都在 n11）
     这个判据看不出错，所以不放进标定集 —— 那是已知盲区，见 FINDINGS.md。 */
  ["该拦下 反义", "n5", "n6"],
  ["该拦下 反义", "n6", "n5"],
  ["该拦下 反义", "n10", "n11"],
  ["该拦下 反义", "n11", "n12"],
  ["该拦下 反义", "n1", "n2"],
  ["该拦下 近义", "n9", "n18"],
  ["该拦下 近义", "n18", "n19"],
  ["该拦下 近义", "n14", "n15"],
  ["该拦下 近义", "n13", "n12"],
  ["该拦下 近义", "n3", "n2"],

  /* ---- 该拦下 · 同词不同指：问题侧看不出差别，检索结果不同 ---- */
  ["该拦下 跨章", "n14", "n16"],
  ["该拦下 跨章", "n16", "n14"],
  ["该拦下 跨章", "n4", "n17"],
  ["该拦下 跨章", "n17", "n4"],

  /* ---- 该拦下 · 人名：学科内容里的实体，六对全排 ---- */
  ["该拦下 人名", "h1", "h2"],
  ["该拦下 人名", "h1", "h3"],
  ["该拦下 人名", "h1", "h4"],
  ["该拦下 人名", "h2", "h3"],
  ["该拦下 人名", "h2", "h4"],
  ["该拦下 人名", "h3", "h4"],

  /* ---- 该拦下 · 完全无关：底线对照 ---- */
  ["该拦下 无关", "n18", "hw3"],
  ["该拦下 无关", "n5", "syl"],
  ["该拦下 无关", "n11", "hw-rule"],
];
const uniqueDocs = new Set(spec.map(x => x[1])).size;
if (generator.kind !== "stub") console.log(`    （真生成，${spec.length} 条用例 / ${uniqueDocs} 篇文档 × ${SAMPLES} 采样 ≈ ${Math.round(generator.approxMsPerCall * uniqueDocs * SAMPLES / 1000)} 秒）`);
if (SAMPLES > 1) console.log(`    每条用例采样 ${SAMPLES} 次，取中位数 —— 随机生成端下单次结果测的是噪声`);

const reuse: Array<number> = [];
const block: Array<number> = [];
/**
 * 采样有效性自检。
 *
 * DeepSeek 在 temperature 0.2 下同 prompt 同输出，实测同一轮内 3 次采样一字不差 ——
 * 那时 `CALIB_SAMPLES` 是空转，显示出来的 `x~x` 区间是假的「已采样」。
 * 与其让人误以为噪声被压掉了，不如把这件事直接说出来。
 */
let degenerate = 0;
for (const [tag, answerDoc, chunkDoc] of spec) {
  const chunkText = byId(chunkDoc).text;
  const scores: Array<number> = [];
  for (let k = 0; k < SAMPLES; k++) {
    const answer = await compose(byId(answerDoc), k);
    const [av, cv2] = await enc.embedPassage([answer, chunkText]);
    scores.push(cosine(av, cv2));
  }
  const m = median(scores);
  (tag.startsWith("该复用") ? reuse : block).push(m);
  const lo = Math.min(...scores), hi = Math.max(...scores);
  if (SAMPLES > 1 && hi - lo < 1e-9) degenerate += 1;
  const spread = SAMPLES > 1 ? `  （${SAMPLES} 次：${lo.toFixed(4)}~${hi.toFixed(4)}）` : "";
  console.log("   ", tag.padEnd(12), `${answerDoc}→${chunkDoc}`.padEnd(11), m.toFixed(4) + spread);
}
// **用中位数，不用 min/max。** 极值统计量对单个坏样本最敏感 —— 生成端一旦是随机的，
// min(该复用) 和 max(该拦下) 测的就是那次最差的采样，而不是分布的位置。
const lo = median(reuse), hi = median(block);
const worst = Math.min(...reuse), best = Math.max(...block);
console.log(`    → 该复用中位 ${lo.toFixed(4)} | 该拦下中位 ${hi.toFixed(4)} | margin ${(lo-hi).toFixed(4)} → ${lo>hi?"可分":"**重叠**"}`);
console.log(`    → 最坏情况：该复用最低 ${worst.toFixed(4)} vs 该拦下最高 ${best.toFixed(4)}${worst>best?"":"　**这两组在最坏情况下重叠 —— 任何单一阈值都会同时犯两种错**"}`);
if (SAMPLES > 1 && degenerate === spec.length) {
  console.log(
    `    ⚠ **采样无效**：${SAMPLES} 次全部逐位相同，CALIB_SAMPLES 在这个生成端上是空转。\n` +
      `      同 prompt 同输出（如 DeepSeek 的 temperature 0.2）时它压不掉任何噪声 ——\n` +
      `      要看抖动请整脚本跑多轮，或换一个会随 seed 变的生成端。`,
  );
} else if (SAMPLES > 1 && degenerate > 0) {
  console.log(`    ⚠ ${degenerate}/${spec.length} 条用例的 ${SAMPLES} 次采样逐位相同 —— 那几条的区间不代表真实抖动。`);
}
if (lo > hi) console.log(`    → 建议 θa高 ≈ ${(lo - (lo-hi)*0.25).toFixed(3)} / θa低 ≈ ${(hi + (lo-hi)*0.25).toFixed(3)}`);
