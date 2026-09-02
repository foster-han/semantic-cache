/** 语言无关的标定：① 重排器判别力 ② 检索 top-1 命中率 */
import { createEncoders, cosine } from "../Models.ts";
import { compose as composeAnswer, DOCS, LANGUAGE, RERANK_PROBES } from "../Corpus.ts";
import { createGenerator } from "../Generators.ts";
import type { CourseDoc } from "../types/Corpus.ts";
const enc = await createEncoders();
function byId(id: string): CourseDoc {
	const doc = DOCS.find(d => d.id === id);
	if (!doc) throw new Error(`标定用例引用了不存在的文档：${id}`);
	return doc;
}

/**
 * **标定必须和运行路径用同一个生成端。** 分叉过一次，代价是英文语料下阈值高过了
 * 天花板，任何条目都无法直接复用。
 *
 * 所以这里走的是 Generators.ts 那个接口：默认 stub（换序换壳），
 * `GEN=claude-cli` 换真生成。
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

function median(xs: ReadonlyArray<number>): number {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * 探针取自语料包（`RERANK_PROBES`）—— 和验证台页面上那个自检**同一份**。
 * 先前这里自带一套写死的问句，于是「页面说可用」和「标定脚本说可用」测的不是同一件事。
 *
 * **b 侧跟着 `CE_TARGET` 走。** ④ 比问↔答时，拿问句当 candidate 标出来的 θq
 * 是另一个尺度上的数 —— 同一个 bge-reranker-base，问↔问的最优闸值 0.1228、
 * 问↔答 0.3494。答案用 `composeAnswer()` 拼，和运行路径同一个函数。
 */
const RERANK_TARGET = enc.models.rerankTarget;
const PROBES = RERANK_PROBES.map(p => {
  if (RERANK_TARGET !== "answer") return [p.label, p.a, p.b, p.shouldMatch];
  const doc = DOCS.find(d => d.id === p.bDoc);
  if (!doc) throw new Error(`探针「${p.label}」的 bDoc=${p.bDoc} 不在语料里 —— 无法为 target: "answer" 构造 candidate。`);
  return [p.label, p.a, composeAnswer([{ title: doc.title, text: doc.text, version: doc.version }]), p.shouldMatch];
});

console.log(`\n== 语言 ${LANGUAGE} ==\n`);
console.log(`① 重排器判别力（${RERANK_TARGET === "answer" ? "问题↔答案" : "问题↔问题"}）　模型 ${enc.models.rerank ?? "无"}`);
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
  if (margin > 0) {
    console.log(`    → 建议 θq ≈ ${((Math.min(...pos) + Math.max(...neg)) / 2).toFixed(3)}`);
    // θq 属于 (模型 × 形态)，抄进 RERANK_CALIBRATIONS 时这两个必须一起记，否则那一行不可复现
    console.log(`      （这个数只对 ${enc.models.rerank ?? "?"} × ${RERANK_TARGET === "answer" ? "问↔答" : "问↔问"} 成立 —— 补进 lab/Calibrations.ts 的 RERANK_CALIBRATIONS 时要连模型与形态一起写）`);
  }
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
