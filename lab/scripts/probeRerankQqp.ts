/**
 * ④ 在 **QQP** 上的判别力，并顺带给出主流可比的两个数。
 *
 * 为什么换数据：18 对手工对子上我栽过两次 —— 3 对时得出「中文全都不可用」，
 * 换 18 对后结论反过来；判据里还混进了 ④ 在流水线里根本见不到的「完全无关」类。
 * QQP 是真人独立写的问题对、带二元标签，也是 GPTCache 用的同一份数据，
 * 所以这里的数字**可以和他们公布的对照**。
 *
 * 三个指标，对齐主流的说法：
 *   命中率     标签 1 的对子里判成「该复用」的比例      ← GPTCache 公布 68.8%
 *   正命中率   判成「该复用」的里面标签确实是 1 的比例   ← GPTCache 公布 >97%
 *   正确拒绝   标签 0 的对子里判成「不复用」的比例      ← 论文里那个 85%
 *
 * **这只覆盖 ④ 的问↔问形态。** QQP 是一对问题加一个标签，没有「资料」这一侧，
 * `CE_TARGET=answer` 在它上面标不了 —— 那个形态仍然留在课程语料上
 * （`scripts/calibrate.ts`）。
 *
 *   node --experimental-strip-types scripts/probeRerankQqp.ts [条数]
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import { createEncoders, cosine } from "../Models.ts";
import { bestHitAtPrecision, pct, scoreFromLogits, sweep as sweepPoints } from "../ProbeMetrics.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, "..", "data", "qqp.json");
const LIMIT = Number(process.argv[2] ?? Number.POSITIVE_INFINITY);

const MODELS = [
	["ms-marco-L6（默认）", "Xenova/ms-marco-MiniLM-L-6-v2"],
	["bge-reranker-base", "Xenova/bge-reranker-base"],
] as const;

interface Pair {
	readonly question1: string;
	readonly question2: string;
	readonly label: number;
}

let pairs: Array<Pair>;
let balanced: boolean | undefined;
try {
	const raw = JSON.parse(await readFile(DATA, "utf8")) as { pairs: Array<Pair>; balanced?: boolean };
	balanced = raw.balanced;
	// **按标签均衡取样。** 文件里正例在前负例在后，直接 slice 会只拿到正例，
	// 那时「正确拒绝」的分母是 0，指标全是 100% 的假象 —— 踩过一次。
	const half = Number.isFinite(LIMIT) ? Math.ceil(LIMIT / 2) : Number.POSITIVE_INFINITY;
	pairs = [
		...raw.pairs.filter(p => p.label === 1).slice(0, half),
		...raw.pairs.filter(p => p.label === 0).slice(0, half),
	];
} catch {
	console.error(`读不到 ${DATA}。先跑：node --experimental-strip-types scripts/fetchQqp.ts`);
	process.exit(1);
}
const wantHit = pairs.filter(p => p.label === 1).length;
console.log(`QQP ${pairs.length} 对：该命中 ${wantHit}　该未命中 ${pairs.length - wantHit}　正例率 ${((wantHit / pairs.length) * 100).toFixed(1)}%`);
/**
 * 正例率必须跟着数字一起报。**两类指标对它的依赖方向相反**：命中率与正确拒绝各自
 * 只看一个标签的分母，不受影响；正命中率(precision) 的分母混了两类，正例率越高越好看。
 * 所以拿这里的 precision 跟别人公布的数字对照时，先确认两边的正例率。
 */
console.log(
	balanced === false
		? "  原始比例，precision 无偏\n"
		: `  ⚠ ${balanced === undefined ? "这份数据没记 balanced 字段（旧文件），大概是均衡取样的" : "已按标签均衡"}` +
			"　—— 正命中率**偏乐观**（QQP 原始正例率约 37%）。要无偏的：QQP_BALANCE=0 重跑 fetchQqp\n",
);

/**
 * 扫阈值。**不按「错误最少」挑**，而是把整条曲线摆出来 ——
 * 一个语义缓存里假正（返回错答案）和假负（白花一次生成）的代价完全不同，
 * 该选哪个点是产品决定，不是脚本决定。
 *
 * 指标实现在 `ProbeMetrics.ts`，和其余探针共用一份 —— 三份各抄一遍的时候，
 * 其中一份的 logits 路数判断是错的。
 */
function sweep(scores: ReadonlyArray<number>, labels: ReadonlyArray<number>): void {
	const points = sweepPoints(scores, labels);
	const f = (p: { hit: number; precision: number }): number =>
		p.hit + p.precision === 0 ? 0 : (2 * p.hit * p.precision) / (p.hit + p.precision);
	const best = points.reduce((a, b) => (f(b) > f(a) ? b : a));
	console.log(
		`  F1 最优 θ=${best.theta.toFixed(4)}　命中率 ${pct(best.hit)}　正命中率 ${pct(best.precision)}　正确拒绝 ${pct(best.reject)}`,
	);
	// 主流以「正命中率」为硬约束，所以再报几个正命中率门槛下能做到的命中率
	for (const floor of [0.99, 0.97, 0.95, 0.9]) {
		const r = bestHitAtPrecision(points, labels, floor);
		console.log(
			r === "baseline-already-passes"
				? `  正命中率 ≥ ${pct(floor)} 时　**基线已达标** —— 全放行就够，这个门槛在当前正例率下没有区分力`
				: r === null
					? `  正命中率 ≥ ${pct(floor)} 时　**做不到**`
					: `  正命中率 ≥ ${pct(floor)} 时　命中率最高 ${pct(r.hit)}（θ=${r.theta.toFixed(4)}，正确拒绝 ${pct(r.reject)}）`,
		);
	}
}

/**
 * ③ 也要放进同一把尺子。
 *
 * **GPTCache 公布的 68.8% / >97% 是嵌入相似度那道闸的数字**，对应这里的 ③（bi-encoder
 * 余弦），不是 ④。只报 ④ 没法跟他们对照 —— 那是两道不同的闸。
 */
{
	console.log("=== ③ 召回（bi-encoder 余弦，对应 GPTCache 的 similarity_threshold）===");
	const enc = await createEncoders();
	const a = await enc.embedQuestions(pairs.map(p => p.question1));
	const b = await enc.embedQuestions(pairs.map(p => p.question2));
	sweep(
		pairs.map((_, i) => cosine(a[i], b[i])),
		pairs.map(p => p.label),
	);
	console.log("");
}

for (const [label, id] of MODELS) {
	console.log(`=== ④ 精排 · ${label} ===`);
	const tok = await AutoTokenizer.from_pretrained(id);
	const model = await AutoModelForSequenceClassification.from_pretrained(id);
	const labels = Object.values((model.config as { id2label?: Record<string, string> }).id2label ?? {});
	const entail = labels.findIndex(l => /entail/i.test(l));
	const scores: Array<number> = [];
	for (const p of pairs) {
		const inp = await tok(p.question1, { text_pair: p.question2, padding: true, truncation: true });
		const { logits } = await model(inp);
		scores.push(
			scoreFromLogits(Array.from(logits.data as ArrayLike<number>, Number), logits.dims as ReadonlyArray<number>, entail),
		);
	}
	sweep(scores, pairs.map(p => p.label));
	console.log("");
}
