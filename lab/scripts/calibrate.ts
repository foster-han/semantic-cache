/** 语言无关的标定：① 重排器判别力 ② ⑥ 支撑度阈值 ③ 检索 top-1 命中率 */
import { createEncoders, cosine } from "../Models.ts";
import { compose as composeAnswer, DOCS, LANGUAGE } from "../Corpus.ts";
import { createGenerator } from "../Generators.ts";
const enc = await createEncoders();
const byId = id => DOCS.find(d => d.id === id);

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

const answerCache = new Map();
async function compose(d, sample = 0) {
  const key = `${d.id}#${sample}`;
  if (answerCache.has(key)) return answerCache.get(key);
  if (generator.kind === "stub") {
    const text = composeAnswer([d]);
    answerCache.set(key, text);
    return text;
  }
  // 真生成要有问题可答 —— 用文档标题构成学生会问的那句话
  const q = LANGUAGE === "en" ? `What is ${d.title}?` : `${d.title}是什么？`;
  const payload = await generator.generate(
    { matchText: q, retrievalText: q, context: {} },
    [{ id: d.id, text: d.text, score: 1, title: d.title, version: d.version }],
  );
  const text = payload.kind === "answer" ? payload.answer : "";
  answerCache.set(key, text);
  return text;
}

const median = xs => {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const PROBES = LANGUAGE === "en" ? [
  ["paraphrase   should MATCH", "What is overfitting?", "What does overfitting mean?", true],
  ["near-antonym should DIFFER", "What is overfitting?", "What is underfitting?", false],
  ["unrelated    should DIFFER", "What is overfitting?", "When are grades released?", false],
  ["identical    should MATCH", "What is overfitting?", "What is overfitting?", true],
] : [
  ["同义      应高", "什么是过拟合？", "过拟合是什么意思？", true],
  ["近义反义   应低", "什么是过拟合？", "什么是欠拟合？", false],
  ["完全无关   应低", "什么是过拟合？", "成绩什么时候公布？", false],
  ["逐字相同   应高", "什么是过拟合？", "什么是过拟合？", true],
];

console.log(`\n== 语言 ${LANGUAGE} ==\n`);
console.log("① 重排器判别力（问题↔问题）");
const rr = [];
for (const [tag, a, b, want] of PROBES) {
  const s = await enc.rerank(a, b);
  rr.push({ s, want });
  console.log("   ", tag.padEnd(28), s === null ? "无重排器" : s.toFixed(4));
}
if (rr[0].s !== null) {
  const pos = rr.filter(r => r.want).map(r => r.s), neg = rr.filter(r => !r.want).map(r => r.s);
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
if (generator.kind !== "stub") console.log(`    （真生成，${10} 条用例，约 ${Math.round(generator.approxMsPerCall * 8 / 1000)} 秒）`);
const spec = [
  ["该复用", "n5", "n5"],
  ["该复用", "n13", "n13"],
  ["该复用", "n11", "n11"],
  ["该拦下 反义", "n5", "n6"],
  ["该拦下 反义", "n11", "n10"],
  ["该拦下 跨章", "n14", "n16"],
  ["该拦下 跨章", "n4", "n17"],
  // 个人数据已从语料里移除（那是路由 + 授权的事），相应的标定用例也随之删除
  ["该拦下 人名", "h1", "h2"],
  ["该拦下 人名", "h3", "h4"],
  ["该拦下 无关", "n18", "hw3"],
];
if (SAMPLES > 1) console.log(`    每条用例采样 ${SAMPLES} 次，取中位数 —— 随机生成端下单次结果测的是噪声`);

const reuse = [], block = [];
for (const [tag, answerDoc, chunkDoc] of spec) {
  const chunkText = byId(chunkDoc).text;
  const scores = [];
  for (let k = 0; k < SAMPLES; k++) {
    const answer = await compose(byId(answerDoc), k);
    const [av, cv2] = await enc.embedPassage([answer, chunkText]);
    scores.push(cosine(av, cv2));
  }
  const m = median(scores);
  (tag.startsWith("该复用") ? reuse : block).push(m);
  const spread = SAMPLES > 1 ? `  （${SAMPLES} 次：${Math.min(...scores).toFixed(4)}~${Math.max(...scores).toFixed(4)}）` : "";
  console.log("   ", tag.padEnd(12), m.toFixed(4) + spread);
}
// **用中位数，不用 min/max。** 极值统计量对单个坏样本最敏感 —— 生成端一旦是随机的，
// min(该复用) 和 max(该拦下) 测的就是那次最差的采样，而不是分布的位置。
const lo = median(reuse), hi = median(block);
const worst = Math.min(...reuse), best = Math.max(...block);
console.log(`    → 该复用中位 ${lo.toFixed(4)} | 该拦下中位 ${hi.toFixed(4)} | margin ${(lo-hi).toFixed(4)} → ${lo>hi?"可分":"**重叠**"}`);
console.log(`    → 最坏情况：该复用最低 ${worst.toFixed(4)} vs 该拦下最高 ${best.toFixed(4)}${worst>best?"":"　**这两组在最坏情况下重叠 —— 任何单一阈值都会同时犯两种错**"}`);
if (lo > hi) console.log(`    → 建议 θa高 ≈ ${(lo - (lo-hi)*0.25).toFixed(3)} / θa低 ≈ ${(hi + (lo-hi)*0.25).toFixed(3)}`);
