/**
 * θq=0.3494 这个数有多可信？
 *
 * `_probe_ce6.ts` 报的 4/18 是**训练误差** —— 阈值是扫遍这 18 对的所有切点、取错误
 * 最少的那个，也就是在同一份数据上优化出来的。所以它系统性偏乐观，不能当泛化误差读。
 *
 * 这里做四件事，**两种形态各做一遍** —— 只查问↔答那一行，等于让问↔问那行
 * 继续以「测出来的最优值」的样子留在表里：
 *   0 平台宽度     —— 最优错误数对应的 θ 区间。宽 = 这份数据定不出 θq 的位置
 *   A 留一交叉验证 —— 每次用 17 对定阈值、判留出的那 1 对，去掉上面那个偏差
 *   B bootstrap    —— 重采样看最优 θq 自己的分布有多宽
 *   C 敏感度       —— 换负例结构（人名对在真实流量里占不到 44%）结论会不会翻
 */
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import { compose, DOCS } from "./Corpus.ts";

interface Pair {
	readonly a: string;
	readonly b: string;
	readonly docB: string;
	readonly reuse: boolean;
	/** 负例的种类 —— 敏感度分析要按它分组 */
	readonly kind: "para" | "antonym" | "person" | "samedoc";
}

const PAIRS: ReadonlyArray<Pair> = [
	{ a: "什么是过拟合？", b: "过拟合是什么意思？", docB: "n5", reuse: true, kind: "para" },
	{ a: "学习率太大会怎么样？", b: "学习率设得过大有什么后果？", docB: "n3", reuse: true, kind: "para" },
	{ a: "为什么要做 k 折交叉验证？", b: "交叉验证有什么用？", docB: "n13", reuse: true, kind: "para" },
	{ a: "偏差和方差是什么关系？", b: "偏差方差怎么权衡？", docB: "n7", reuse: true, kind: "para" },
	{ a: "特征归一化怎么做？", b: "为什么要对特征做归一化？", docB: "n14", reuse: true, kind: "para" },
	{ a: "决策树为什么要剪枝？", b: "剪枝是为了解决什么问题？", docB: "n18", reuse: true, kind: "para" },
	{ a: "早停是怎么回事？", b: "训练什么时候该停下来？", docB: "n9", reuse: true, kind: "para" },
	{ a: "损失函数是干什么的？", b: "为什么需要损失函数？", docB: "n2", reuse: true, kind: "para" },
	{ a: "集成方法是什么？", b: "为什么把多个模型合起来会更好？", docB: "n19", reuse: true, kind: "para" },
	{ a: "什么是过拟合？", b: "什么是欠拟合？", docB: "n6", reuse: false, kind: "antonym" },
	{ a: "准确率是什么？", b: "精确率是什么？", docB: "n11", reuse: false, kind: "antonym" },
	{ a: "早停怎么防止过拟合？", b: "剪枝怎么防止过拟合？", docB: "n18", reuse: false, kind: "antonym" },
	{ a: "决策树是怎么工作的？", b: "集成方法是怎么工作的？", docB: "n19", reuse: false, kind: "antonym" },
	{ a: "数值特征要怎么预处理？", b: "类别特征要怎么预处理？", docB: "n15", reuse: false, kind: "antonym" },
	{ a: "Hinton 提出了什么方法？", b: "LeCun 提出了什么方法？", docB: "h2", reuse: false, kind: "person" },
	{ a: "Vapnik 提出了什么方法？", b: "Breiman 提出了什么方法？", docB: "h4", reuse: false, kind: "person" },
	{ a: "L1 正则化有什么特点？", b: "L2 正则化有什么特点？", docB: "n8", reuse: false, kind: "samedoc" },
	{ a: "精确率是什么？", b: "召回率是什么？", docB: "n11", reuse: false, kind: "samedoc" },
];

const byId = new Map(DOCS.map(d => [d.id, d]));
function answerOf(id: string): string {
	const d = byId.get(id);
	if (!d) throw new Error(`语料里没有 ${id}`);
	return compose([{ title: d.title, text: d.text, version: d.version }]);
}

const tok = await AutoTokenizer.from_pretrained("Xenova/bge-reranker-base");
const model = await AutoModelForSequenceClassification.from_pretrained("Xenova/bge-reranker-base");
async function score(a: string, b: string): Promise<number> {
	const inp = await tok(a, { text_pair: b, padding: true, truncation: true });
	const { logits } = await model(inp);
	return 1 / (1 + Math.exp(-Number((logits.data as ArrayLike<number>)[0])));
}

/** 两种形态各算一份分数。candidate 是旧答案还是旧问题，就是 CE_TARGET 那个选择 */
const SCORES = new Map<"answer" | "question", Array<number>>();
for (const form of ["answer", "question"] as const) {
	const xs: Array<number> = [];
	for (const p of PAIRS) xs.push(await score(p.a, form === "answer" ? answerOf(p.docB) : p.b));
	SCORES.set(form, xs);
}
let S: Array<number> = [];

for (const FORM of ["answer", "question"] as const) {
	S = SCORES.get(FORM) as Array<number>;
	process.stdout.write(`\n${"=".repeat(78)}\n### 形态：${FORM === "answer" ? "问↔答" : "问↔问"}\n${"=".repeat(78)}\n`);
	/** 在给定索引子集上扫最优阈值。返回最优 θ 的**区间**（平台），以及错误数 */
	function best(idx: ReadonlyArray<number>): { lo: number; hi: number; errors: number } {
		const cuts = [0, ...[...new Set(idx.map(i => S[i]))].sort((x, y) => x - y).flatMap((s, k, arr) => (k + 1 < arr.length ? [(s + arr[k + 1]) / 2] : [])), 1];
		let bestErr = Number.POSITIVE_INFINITY;
		const winners: Array<number> = [];
		for (const t of cuts) {
			let e = 0;
			for (const i of idx) if (PAIRS[i].reuse ? S[i] < t : S[i] >= t) e++;
			if (e < bestErr) {
				bestErr = e;
				winners.length = 0;
			}
			if (e === bestErr) winners.push(t);
		}
		return { lo: Math.min(...winners), hi: Math.max(...winners), errors: bestErr };
	}

	const all = PAIRS.map((_, i) => i);
	const full = best(all);
	process.stdout.write(`\n=== 基线（训练误差，阈值在这同一份数据上选的）===\n`);
	process.stdout.write(`  错 ${full.errors}/18　最优 θq 平台 ${full.lo.toFixed(4)} ~ ${full.hi.toFixed(4)}（宽 ${(full.hi - full.lo).toFixed(4)}），中点 ${((full.lo + full.hi) / 2).toFixed(4)}\n`);

	/* ---------- A 留一交叉验证 ---------- */
	let looErr = 0;
	const looFails: Array<string> = [];
	for (const i of all) {
		const rest = all.filter(j => j !== i);
		const b = best(rest);
		const theta = (b.lo + b.hi) / 2;
		const wrong = PAIRS[i].reuse ? S[i] < theta : S[i] >= theta;
		if (wrong) {
			looErr++;
			looFails.push(`${PAIRS[i].reuse ? "该复用" : "该拦下"}(${PAIRS[i].kind}) ${S[i].toFixed(4)} vs θ=${theta.toFixed(4)}　${PAIRS[i].a} ／ ${PAIRS[i].b}`);
		}
	}
	process.stdout.write(`\n=== A 留一交叉验证（去掉「同一份数据上选阈值」的偏差）===\n`);
	process.stdout.write(`  错 ${looErr}/18 = ${((looErr / 18) * 100).toFixed(1)}%　（基线 ${full.errors}/18 = ${((full.errors / 18) * 100).toFixed(1)}%）\n`);
	for (const f of looFails) process.stdout.write(`    ✗ ${f}\n`);

	/* ---------- B bootstrap ---------- */
	let seed = 42;
	function rnd(): number {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	}
	const thetas: Array<number> = [];
	const errRates: Array<number> = [];
	for (let b = 0; b < 2000; b++) {
		const idx = all.map(() => Math.floor(rnd() * 18));
		// 重采样里必须两类都有，否则最优阈值退化成 0 或 1
		if (!idx.some(i => PAIRS[i].reuse) || !idx.some(i => !PAIRS[i].reuse)) continue;
		const r = best(idx);
		thetas.push((r.lo + r.hi) / 2);
		// 用这次重采样定的阈值去判**全部** 18 对 —— out-of-bag 味道的泛化估计
		const t = (r.lo + r.hi) / 2;
		let e = 0;
		for (const i of all) if (PAIRS[i].reuse ? S[i] < t : S[i] >= t) e++;
		errRates.push(e);
	}
	function q(xs: ReadonlyArray<number>, p: number): number {
		const a = [...xs].sort((x, y) => x - y);
		return a[Math.min(a.length - 1, Math.floor(p * a.length))];
	}
	process.stdout.write(`\n=== B bootstrap（${thetas.length} 次重采样，每次重新选最优 θq）===\n`);
	process.stdout.write(`  θq 中位 ${q(thetas, 0.5).toFixed(4)}　80% 区间 ${q(thetas, 0.1).toFixed(4)} ~ ${q(thetas, 0.9).toFixed(4)}　95% 区间 ${q(thetas, 0.025).toFixed(4)} ~ ${q(thetas, 0.975).toFixed(4)}\n`);
	process.stdout.write(`  用重采样阈值判全部 18 对：错误中位 ${q(errRates, 0.5)}　80% 区间 ${q(errRates, 0.1)} ~ ${q(errRates, 0.9)}\n`);

	/* ---------- C 敏感度：负例结构 ---------- */
	process.stdout.write(`\n=== C 敏感度：换掉负例结构（现在 9 负例里 2 对人名 + 2 对同篇）===\n`);
	const variants: ReadonlyArray<readonly [string, (p: Pair) => boolean]> = [
		["全部 18 对（基线）", () => true],
		["去掉 2 对人名（真实流量里占不到 44%）", p => p.kind !== "person"],
		["去掉 2 对同篇（⑥ 也够不着的那族）", p => p.kind !== "samedoc"],
		["只留近义反义当负例（最难的一类）", p => p.reuse || p.kind === "antonym"],
	];
	for (const [label, keep] of variants) {
		const idx = all.filter(i => keep(PAIRS[i]));
		const r = best(idx);
		const pos = idx.filter(i => PAIRS[i].reuse).length;
		process.stdout.write(
			`  ${label.padEnd(38)} n=${idx.length}（${pos} 复用/${idx.length - pos} 拦下）　错 ${r.errors}/${idx.length} = ${((r.errors / idx.length) * 100).toFixed(0)}%　θq 平台 ${r.lo.toFixed(4)}~${r.hi.toFixed(4)}\n`,
		);
	}

}
