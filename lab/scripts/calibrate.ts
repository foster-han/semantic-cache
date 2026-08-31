/** 语言无关的标定：① 重排器判别力 ② ⑥ 支撑度阈值 ③ 检索 top-1 命中率 */
import { createEncoders, cosine } from "../Models.ts";
import { compose as composeAnswer, DOCS, LANGUAGE } from "../Corpus.ts";
const enc = await createEncoders();
const byId = id => DOCS.find(d => d.id === id);
// **和运行路径用同一个 compose** —— 标定与实现分叉过一次，代价是英文语料下
// 阈值高过了支撑度天花板，任何条目都无法直接复用。
const compose = d => composeAnswer([d]);

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

console.log("\n③ ⑥ 支撑度阈值（答案↔片段，同一 passage 空间）");
const cases = [
  ["该复用", compose(byId("n5")), byId("n5").text],
  ["该复用", compose(byId("n13")), byId("n13").text],
  ["该复用", compose(byId("n11")), byId("n11").text],
  ["该拦下 反义", compose(byId("n5")), byId("n6").text],
  ["该拦下 反义", compose(byId("n11")), byId("n10").text],
  ["该拦下 跨章", compose(byId("n14")), byId("n16").text],
  ["该拦下 跨章", compose(byId("n4")), byId("n17").text],
  // 个人数据已从语料里移除（那是路由 + 授权的事），相应的标定用例也随之删除
  ["该拦下 人名", compose(byId("h1")), byId("h2").text],
  ["该拦下 人名", compose(byId("h3")), byId("h4").text],
  ["该拦下 无关", compose(byId("n18")), byId("hw3").text],
];
const av = await enc.embedPassage(cases.map(c => c[1]));
const cv2 = await enc.embedPassage(cases.map(c => c[2]));
const reuse = [], block = [];
for (let i = 0; i < cases.length; i++) {
  const s = cosine(av[i], cv2[i]);
  (cases[i][0].startsWith("该复用") ? reuse : block).push(s);
  console.log("   ", cases[i][0].padEnd(12), s.toFixed(4));
}
const lo = Math.min(...reuse), hi = Math.max(...block);
console.log(`    → 该复用最低 ${lo.toFixed(4)} | 该拦下最高 ${hi.toFixed(4)} | margin ${(lo-hi).toFixed(4)} → ${lo>hi?"可分":"**重叠**"}`);
if (lo > hi) console.log(`    → 建议 θa高 ≈ ${(lo - (lo-hi)*0.25).toFixed(3)} / θa低 ≈ ${(hi + (lo-hi)*0.25).toFixed(3)}`);
