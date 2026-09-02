/**
 * ③ 三个配置在**同一份 QQP** 上的完整曲线。
 *
 * 指标定义直接照搬 `scripts/probeRerankQqp.ts` 的 `sweep()` —— 换个定义就没法跟
 * 那一轮的数字对照了，而对照才是换数据集的目的。
 *
 * 小样本自检（_probe_langcache.ts）已经量到：同一个 langcache-embed-v1，CLS pooling
 * margin +0.0272、mean −0.0355（不可分）。这里看它在 1000 对上是不是同一个方向，
 * 以及正命中率能不能进到 GPTCache 公布的 >97% 那个区间。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@huggingface/transformers";
import { cosine } from "./Models.ts";
import { bestHitAtPrecision, pct, sweep } from "./ProbeMetrics.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, "data", "qqp.json");

interface Pair {
	readonly question1: string;
	readonly question2: string;
	readonly label: number;
}
const raw = JSON.parse(await readFile(DATA, "utf8")) as { pairs: Array<Pair> };
const pairs = raw.pairs;
const wantHit = pairs.filter(p => p.label === 1).length;
process.stdout.write(`QQP ${pairs.length} 对：该命中 ${wantHit}　该未命中 ${pairs.length - wantHit}\n`);
process.stdout.write(`⚠ 正例率 ${((wantHit / pairs.length) * 100).toFixed(0)}%，而 QQP 原始约 37% —— fetchQqp 做了标签均衡。\n`);
process.stdout.write(`  正命中率（precision）随正例率上升而偏高，所以下面的正命中率是**乐观**的；命中率与正确拒绝不受影响。\n`);

/** 指标口径与 scripts/probeRerankQqp.ts 一致（同一个 ProbeMetrics.sweep），所以可直接对照 */
function report(scores: ReadonlyArray<number>, labels: ReadonlyArray<number>): void {
	const points = sweep(scores, labels);
	const best = points.reduce((a, b) => {
		const f = (p: { hit: number; precision: number }) => (p.hit + p.precision === 0 ? 0 : (2 * p.hit * p.precision) / (p.hit + p.precision));
		return f(b) > f(a) ? b : a;
	});
	process.stdout.write(
		`  F1 最优 θ=${best.theta.toFixed(4)}　命中率 ${pct(best.hit)}　正命中率 ${pct(best.precision)}　正确拒绝 ${pct(best.reject)}
`,
	);
	for (const floor of [0.99, 0.97, 0.95, 0.9]) {
		const r = bestHitAtPrecision(points, labels, floor);
		process.stdout.write(
			r === "baseline-already-passes"
				? `  正命中率 ≥ ${pct(floor)} 时　**基线已达标**（全放行就够，这个门槛在这份数据上没有区分力）
`
				: r === null
					? `  正命中率 ≥ ${pct(floor)} 时　**做不到**
`
					: `  正命中率 ≥ ${pct(floor)} 时　命中率最高 ${pct(r.hit)}（θ=${r.theta.toFixed(4)}）
`,
		);
	}
}

const CONFIGS = [
	["当时的 ③（多语种句对模型 + mean）—— 现默认已是 all-MiniLM-L6-v2", "Xenova/paraphrase-multilingual-MiniLM-L12-v2", "mean"],
	["langcache-embed-v1 · CLS（正确用法）", "redis/langcache-embed-v1", "cls"],
	["langcache-embed-v1 · mean（**故意配错**）", "redis/langcache-embed-v1", "mean"],
] as const;

for (const [label, id, pooling] of CONFIGS) {
	process.stdout.write(`\n=== ${label} ===\n`);
	const ex = await pipeline("feature-extraction", id, { dtype: "fp32" });
	const scores: Array<number> = [];
	const BATCH = 64;
	for (let i = 0; i < pairs.length; i += BATCH) {
		const chunk = pairs.slice(i, i + BATCH);
		const out = await ex(chunk.flatMap(p => [p.question1, p.question2]), { pooling, normalize: true });
		const v = out.tolist() as Array<Array<number>>;
		for (let k = 0; k < chunk.length; k++) scores.push(cosine(v[k * 2], v[k * 2 + 1]));
	}
	report(scores, pairs.map(p => p.label));
}
