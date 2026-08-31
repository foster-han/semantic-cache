/**
 * 标定 ③ 召回下限用的**余弦**阈值（句对模型尺度），与重排器的尺度分开。
 *
 * 注意它不再叫「④ 的退化路径」：SDK 已经删掉了「没有重排器就拿 θq 去卡召回余弦」
 * 那条路 —— 没有 `RerankStage` 就是没有 ④ 这道闸。这个脚本仍然有用，
 * 但它标的是 `recallFloor`，而且结论通常是**纯余弦分不开近义反义**（那正是要 ④ 的理由）。
 */
import { createEncoders, cosine } from "../Models.ts";
const enc = await createEncoders();
const P = [
  ["paraphrase  should MATCH", "What is overfitting?", "What does overfitting mean?", true],
  ["paraphrase  should MATCH", "Why do we do k-fold cross-validation?", "What is cross-validation good for?", true],
  ["paraphrase  should MATCH", "What happens if the learning rate is too large?", "What goes wrong when you set the learning rate too high?", true],
  ["near-anton  should DIFFER", "What is overfitting?", "What is underfitting?", false],
  ["near-anton  should DIFFER", "What is precision?", "What is recall?", false],
  ["near-anton  should DIFFER", "What are the properties of L1 regularisation?", "What are the properties of L2 regularisation?", false],
  ["unrelated   should DIFFER", "How do you prune a decision tree?", "Which metrics does homework three ask for?", false],
];
const emb = await enc.embedQuestions(P.flatMap(p => [p[1], p[2]]));
const rows = P.map((p, i) => ({ tag: p[0], want: p[3], s: cosine(emb[i*2], emb[i*2+1]) }));
for (const r of rows) console.log("   ", r.tag.padEnd(26), r.s.toFixed(4));
const pos = rows.filter(r => r.want).map(r => r.s), neg = rows.filter(r => !r.want).map(r => r.s);
const lo = Math.min(...pos), hi = Math.max(...neg);
console.log(`\n  正例最低 ${lo.toFixed(4)} | 负例最高 ${hi.toFixed(4)} | margin ${(lo-hi).toFixed(4)} → ${lo>hi?"可分":"**重叠，纯余弦分不开**"}`);
if (lo > hi) console.log(`  → 余弦尺度的 θq ≈ ${((lo+hi)/2).toFixed(3)}`);
else console.log(`  → 纯余弦无法分开近义反义；这正是需要精排的理由`);
