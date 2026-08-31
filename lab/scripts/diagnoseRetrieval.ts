import { createEncoders, cosine } from "../Models.ts";
import { DOCS } from "../Corpus.ts";
const enc = await createEncoders();
console.log("检索模型:", enc.retrievalModel);
const qs = ["什么是过拟合？", "过拟合是什么意思？", "什么是欠拟合？", "学习率太大会怎么样？",
            "为什么要做 k 折交叉验证？", "精确率是什么？", "召回率是什么？", "李四的作业二为什么扣分？"];
const dv = await enc.embedPassage(DOCS.map(d => d.text));
const qv = await enc.embedQuery(qs);
let hitTop1 = 0;
const want = { 0:"过拟合",1:"过拟合",2:"欠拟合",3:"梯度下降",4:"交叉验证",5:"精确率与召回率",6:"精确率与召回率",7:null };
for (let i = 0; i < qs.length; i++) {
  const r = DOCS.map((d, j) => ({ t: d.title, s: cosine(qv[i], dv[j]) })).sort((a,b)=>b.s-a.s).slice(0,3);
  const ok = want[i] === null ? "?" : (r[0].t === want[i] ? "ok" : "XX");
  if (r[0].t === want[i]) hitTop1++;
  console.log(`\n${ok} ${qs[i]}`);
  for (const x of r) console.log("     ", x.s.toFixed(4), x.t);
}
console.log(`\ntop-1 命中正确文档: ${hitTop1}/7`);
