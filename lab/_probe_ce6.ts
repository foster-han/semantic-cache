/**
 * ④ 的 candidate 传**旧问题**还是**旧答案**？
 *
 * DESIGN 的「三个模型角色」一节写着：`Reranker.score(query, candidate)` 传旧问题需要句对
 * 训练的模型，传旧答案就正好是 query→passage、段落重排器适用。而 FINDINGS 已经量到：
 * 这条技术栈上拿不到 Quora/STS-B 那类句对 cross-encoder（全都没有 ONNX 版），
 * 手上唯一可用的 `bge-reranker-base` 恰恰是 query→passage 训练的。
 *
 * 所以这个探针换的不是模型，是**任务形态** —— 让 bge 干它被训练的那件事。
 * 2×2：{bge, mDeBERTa-xnli} × {问题↔问题, 问题↔答案}。
 *
 * 「答案」用语料的 `compose()` 拼，和运行路径同一个函数 —— 探针与实现不可分叉，
 * 这是 ⑥ 那条「标定与实现必须同算子」的同一条规矩。
 *
 * 主指标不是 margin 而是**最优单阈值下的错误数**：margin 只看两个极值，
 * 一个坏样本就能把它打成负数，看不出「除了那一对以外都分得开」。
 */
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import { compose, DOCS } from "./Corpus.ts";
import { createGenerator } from "./Generators.ts";

const MODELS = [
	["bge", "bge-reranker-base", "Xenova/bge-reranker-base"],
	["nli", "mDeBERTa-v3-xnli", "Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7"],
] as const;

interface Pair {
	readonly a: string;
	readonly b: string;
	/** 本次提问的答案该依据哪篇 */
	readonly docA: string;
	/** 缓存里那条的答案依据哪篇 */
	readonly docB: string;
	readonly shouldReuse: boolean;
}

/** 该复用：同一意图的两种问法，依据同一篇 */
const SAME: ReadonlyArray<Pair> = [
	{ a: "什么是过拟合？", b: "过拟合是什么意思？", docA: "n5", docB: "n5", shouldReuse: true },
	{ a: "学习率太大会怎么样？", b: "学习率设得过大有什么后果？", docA: "n3", docB: "n3", shouldReuse: true },
	{ a: "为什么要做 k 折交叉验证？", b: "交叉验证有什么用？", docA: "n13", docB: "n13", shouldReuse: true },
	{ a: "偏差和方差是什么关系？", b: "偏差方差怎么权衡？", docA: "n7", docB: "n7", shouldReuse: true },
	{ a: "特征归一化怎么做？", b: "为什么要对特征做归一化？", docA: "n14", docB: "n14", shouldReuse: true },
	{ a: "决策树为什么要剪枝？", b: "剪枝是为了解决什么问题？", docA: "n18", docB: "n18", shouldReuse: true },
	{ a: "早停是怎么回事？", b: "训练什么时候该停下来？", docA: "n9", docB: "n9", shouldReuse: true },
	{ a: "损失函数是干什么的？", b: "为什么需要损失函数？", docA: "n2", docB: "n2", shouldReuse: true },
	{ a: "集成方法是什么？", b: "为什么把多个模型合起来会更好？", docA: "n19", docB: "n19", shouldReuse: true },
];

/**
 * 该拦下：问法极像但问的不是同一件事。
 *
 * 最后两对的两个问题**合法指向同一篇**（L1/L2 都在 n8，精确率/召回率都在 n11）——
 * 这是 FINDINGS「已知的测试集盲区」那节说的事：那时按 `expectDoc`（答案的首要依据）判，
 * 在它们身上就没有信号。判据后来降到 space 级，这个盲区因此扩大到了整份场景集。
 * 但对 ④ 来说它们是**正当负例**（问的确实不是同一件事），所以计入统计，只是单独标出来：
 * Q↔A 形态下它们的 candidate 就是同一段文本，必然同分，那是这个形态的结构性代价。
 */
const DIFF: ReadonlyArray<Pair> = [
	{ a: "什么是过拟合？", b: "什么是欠拟合？", docA: "n5", docB: "n6", shouldReuse: false },
	{ a: "准确率是什么？", b: "精确率是什么？", docA: "n10", docB: "n11", shouldReuse: false },
	{ a: "早停怎么防止过拟合？", b: "剪枝怎么防止过拟合？", docA: "n9", docB: "n18", shouldReuse: false },
	{ a: "决策树是怎么工作的？", b: "集成方法是怎么工作的？", docA: "n18", docB: "n19", shouldReuse: false },
	{ a: "数值特征要怎么预处理？", b: "类别特征要怎么预处理？", docA: "n14", docB: "n15", shouldReuse: false },
	{ a: "Hinton 提出了什么方法？", b: "LeCun 提出了什么方法？", docA: "h1", docB: "h2", shouldReuse: false },
	{ a: "Vapnik 提出了什么方法？", b: "Breiman 提出了什么方法？", docA: "h3", docB: "h4", shouldReuse: false },
	{ a: "L1 正则化有什么特点？", b: "L2 正则化有什么特点？", docA: "n8", docB: "n8", shouldReuse: false },
	{ a: "精确率是什么？", b: "召回率是什么？", docA: "n11", docB: "n11", shouldReuse: false },
];

const PAIRS: ReadonlyArray<Pair> = [...SAME, ...DIFF];
const byId = new Map(DOCS.map(d => [d.id, d]));

/**
 * 缓存里那条答案 —— **必须由当前生成端产出**。
 *
 * Q↔A 形态下 candidate 就是这段文本，所以 θq 跟着生成端走：
 * stub 的答案几乎是语料原文照抄，真 LLM 的答案改写、压缩、综合过，
 * 重排器给的分数因此不在一个量程上。`GEN=deepseek` 切到真生成。
 *
 * 键按 (docId, 提问) 缓存 —— 同一篇文档在不同对子里可能被不同的问题问到。
 */
const generator = createGenerator();
const answerCache = new Map<string, string>();

async function answerOf(docId: string, askedWith: string): Promise<string> {
	const doc = byId.get(docId);
	if (!doc) throw new Error(`语料里没有文档 ${docId}`);
	if (generator.kind === "stub") {
		return compose([{ title: doc.title, text: doc.text, version: doc.version }]);
	}
	const key = `${docId}\u0000${askedWith}`;
	const hit = answerCache.get(key);
	if (hit !== undefined) return hit;
	const payload = await generator.generate(
		{ matchText: askedWith, retrievalText: askedWith, context: {} },
		[{ id: doc.id, text: doc.text, score: 1 }],
	);
	const text = payload.kind === "answer" ? payload.answer : "";
	answerCache.set(key, text);
	return text;
}

function softmax(xs: ReadonlyArray<number>): Array<number> {
	const m = Math.max(...xs);
	const e = xs.map(x => Math.exp(x - m));
	const s = e.reduce((p, q) => p + q, 0);
	return e.map(x => x / s);
}

function median(xs: ReadonlyArray<number>): number {
	const a = [...xs].sort((x, y) => x - y);
	const m = a.length >> 1;
	return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function fmt(x: number): string {
	return `${x >= 0 ? "+" : ""}${x.toFixed(4)}`;
}

/**
 * 扫遍所有可能的阈值，取错误数最少的那个。
 * 规则：score ≥ θ 放行（判该复用）。返回最优 θ 与它的假负/假正。
 */
function bestThreshold(scores: ReadonlyArray<number>): { theta: number; fn: number; fp: number; errors: number } {
	const cuts = [...new Set(scores)].sort((x, y) => x - y).flatMap((s, i, arr) => (i + 1 < arr.length ? [(s + arr[i + 1]) / 2] : []));
	let best = { theta: Number.NaN, fn: PAIRS.length, fp: PAIRS.length, errors: PAIRS.length * 2 };
	for (const theta of [0, ...cuts, 1]) {
		let fn = 0;
		let fp = 0;
		PAIRS.forEach((p, i) => {
			if (p.shouldReuse && scores[i] < theta) fn++;
			if (!p.shouldReuse && scores[i] >= theta) fp++;
		});
		if (fn + fp < best.errors) best = { theta, fn, fp, errors: fn + fp };
	}
	return best;
}

const collected = new Map<string, ReadonlyArray<number>>();

for (const [key, label, id] of MODELS) {
	process.stdout.write(`\n${"=".repeat(74)}\n=== ${label}　（生成端 ${generator.kind}）\n${"=".repeat(74)}\n`);
	const tok = await AutoTokenizer.from_pretrained(id);
	const model = await AutoModelForSequenceClassification.from_pretrained(id);
	const labels = Object.values((model.config as { id2label?: Record<string, string> }).id2label ?? {});
	const entail = labels.findIndex(l => /entail/i.test(l));

	async function score(a: string, b: string): Promise<number> {
		const inp = await tok(a, { text_pair: b, padding: true, truncation: true });
		const { logits } = await model(inp);
		const raw = Array.from(logits.data as ArrayLike<number>, Number);
		if (raw.length === 1) return 1 / (1 + Math.exp(-raw[0]));
		return softmax(raw)[entail >= 0 ? entail : raw.length - 1];
	}

	for (const [form, cand] of [
		// candidate 是「缓存里那条条目」的哪一部分。条目本身是 b 这一侧：
		// QQ 取它存的问题，QA 取它存的答案（答案由 b 这个问题生成）。
		["QQ", async (p: Pair) => p.b],
		["QA", (p: Pair) => answerOf(p.docB, p.b)],
	] as const) {
		const scores: Array<number> = [];
		for (const p of PAIRS) scores.push(await score(p.a, await cand(p)));
		collected.set(`${key}-${form}`, scores);

		const pos = scores.filter((_, i) => PAIRS[i].shouldReuse);
		const neg = scores.filter((_, i) => !PAIRS[i].shouldReuse);
		const best = bestThreshold(scores);
		process.stdout.write(
			`\n--- ${form === "QQ" ? "问题↔问题（当前实现）" : "问题↔答案（DESIGN 建议）"} ---\n` +
				`  该复用 9 对：中位 ${median(pos).toFixed(4)}  区间 ${Math.min(...pos).toFixed(4)}~${Math.max(...pos).toFixed(4)}\n` +
				`  该拦下 9 对：中位 ${median(neg).toFixed(4)}  区间 ${Math.min(...neg).toFixed(4)}~${Math.max(...neg).toFixed(4)}\n` +
				`  中位 margin ${fmt(median(pos) - median(neg))}　最坏 margin ${fmt(Math.min(...pos) - Math.max(...neg))}\n` +
				`  **最优单阈值 θq=${best.theta.toFixed(4)}：错 ${best.errors}/18（假负 ${best.fn} 砍掉合法复用，假正 ${best.fp} 放行错答案）**\n`,
		);
		const rows = PAIRS.map((p, i) => ({ p, s: scores[i] })).sort((x, y) => x.s - y.s);
		for (const { p, s } of rows) {
			const wrong = p.shouldReuse ? s < best.theta : s >= best.theta;
			const samedoc = !p.shouldReuse && p.docA === p.docB ? " ⚠同篇" : "";
			process.stdout.write(`    ${wrong ? "✗" : " "} ${s.toFixed(4)}  ${p.shouldReuse ? "该复用" : "该拦下"}${samedoc}  ${p.a} ／ ${p.b}\n`);
		}
	}
}

/**
 * 组合：bge 的 Q↔A 做主判，NLI 的 Q↔Q 只做**低分否决**。
 *
 * 依据是两者的失败模式看着是正交的 —— NLI 在反义对上给极低分（过拟合/欠拟合、L1/L2），
 * 那恰好是 bge 在两种形态下都判错的一类。只当否决器用（而不是 AND 两个阈值），
 * 是因为 NLI 的正例分数摊得很开，拿它当门槛会砍掉大量合法复用。
 */
process.stdout.write(`\n${"=".repeat(74)}\n=== 组合：bge(Q↔A) 主判 + NLI(Q↔Q) 低分否决\n${"=".repeat(74)}\n`);
const bgeQA = collected.get("bge-QA");
const nliQQ = collected.get("nli-QQ");
if (bgeQA && nliQQ) {
	const main = bestThreshold(bgeQA);
	process.stdout.write(`  主判单用：θq=${main.theta.toFixed(4)}  错 ${main.errors}/18（假负 ${main.fn}，假正 ${main.fp}）\n\n`);
	process.stdout.write(`  加否决门槛 δ 之后（NLI(Q↔Q) < δ 则一律拦下）：\n`);
	let bestCombo = { delta: 0, fn: 99, fp: 99, errors: 99 };
	for (const delta of [0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.05, 0.08, 0.1]) {
		let fn = 0;
		let fp = 0;
		PAIRS.forEach((p, i) => {
			const pass = bgeQA[i] >= main.theta && nliQQ[i] >= delta;
			if (p.shouldReuse && !pass) fn++;
			if (!p.shouldReuse && pass) fp++;
		});
		if (fn + fp < bestCombo.errors) bestCombo = { delta, fn, fp, errors: fn + fp };
		process.stdout.write(`    δ=${delta.toFixed(3)}  错 ${fn + fp}/18（假负 ${fn}，假正 ${fp}）\n`);
	}
	process.stdout.write(`\n  最好的 δ=${bestCombo.delta.toFixed(3)}：错 ${bestCombo.errors}/18（假负 ${bestCombo.fn}，假正 ${bestCombo.fp}）\n`);
	process.stdout.write(`  NLI(Q↔Q) 正例最低分 = ${Math.min(...nliQQ.filter((_, i) => PAIRS[i].shouldReuse)).toFixed(4)} —— δ 必须低于它才不误伤\n`);
	process.stdout.write(`  被 δ 救回的负例：\n`);
	PAIRS.forEach((p, i) => {
		if (!p.shouldReuse && bgeQA[i] >= main.theta && nliQQ[i] < bestCombo.delta) {
			process.stdout.write(`      bge ${bgeQA[i].toFixed(4)} → NLI ${nliQQ[i].toFixed(4)}  ${p.a} ／ ${p.b}\n`);
		}
	});
	process.stdout.write(`  仍然漏过的负例：\n`);
	PAIRS.forEach((p, i) => {
		if (!p.shouldReuse && bgeQA[i] >= main.theta && nliQQ[i] >= bestCombo.delta) {
			process.stdout.write(`      bge ${bgeQA[i].toFixed(4)} → NLI ${nliQQ[i].toFixed(4)}  ${p.a} ／ ${p.b}${p.docA === p.docB ? " ⚠同篇" : ""}\n`);
		}
	});
}
