/**
 * 逐打分器 × 逐数据集的完整曲线。**读 `data/scores.json`，不碰模型。**
 *
 * 先前这个脚本自己加载模型跑推理，而 `scorePairs.ts` 已经把同样的分数算过并存盘了 ——
 * 两份实现算同一件事，慢的那份还会因为跑在不同时间而给出对不上的数。现在分工是：
 *   scorePairs.ts       付一次推理成本，把分数与耗时存盘
 *   benchPairs.ts       逐打分器看完整曲线（这个文件）
 *   compareBaselines.ts 自研架构 vs 主流单阈值架构的同尺度对比
 * 后两个都是纯计算，秒级。
 *
 * **三个率**：命中率（该复用的里面复用了几成）、正命中率（复用的里面对了几成）、
 * 正确拒绝（该拦下的里面拦对了几成）。定义在 ProbeMetrics.ts，和其余脚本共用一份。
 *
 *   node --experimental-strip-types scripts/benchPairs.ts
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bestHitAtPrecision, pct, sweep } from "../ProbeMetrics.ts";

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(await readFile(join(here, "..", "data", "scores.json"), "utf8")) as {
	scorers: Array<{ key: string; id: string; kind: string; pooling: string; note: string }>;
	datasets: Array<{ name: string; source: string; labels: Array<number> }>;
	scores: Record<string, Record<string, { scores: Array<number>; msPerPair: number }>>;
};

process.stdout.write(`${raw.datasets.length} 份数据 × ${raw.scorers.length} 个打分器\n`);
for (const d of raw.datasets) {
	const p = d.labels.filter(l => l === 1).length / d.labels.length;
	process.stdout.write(`  ${d.name.padEnd(9)} ${String(d.labels.length).padStart(4)} 对　正例率 ${pct(p)}\n`);
}

/** 汇总：打分器 → 数据集 → 三个门槛下的最高命中率 */
const summary = new Map<string, Map<string, string>>();

for (const s of raw.scorers) {
	process.stdout.write(`\n${"=".repeat(78)}\n${s.key}　${s.id}${s.pooling ? `（${s.pooling}）` : ""}\n${s.note}\n${"=".repeat(78)}\n`);
	for (const d of raw.datasets) {
		const e = raw.scores[s.key]?.[d.name];
		if (!e) continue;
		const points = sweep(e.scores, d.labels);
		const f = (x: { hit: number; precision: number }): number =>
			x.hit + x.precision === 0 ? 0 : (2 * x.hit * x.precision) / (x.hit + x.precision);
		const best = points.reduce((x, y) => (f(y) > f(x) ? y : x));
		process.stdout.write(
			`  --- ${d.name} ---\n    F1 最优 θ=${best.theta.toFixed(4)}　命中率 ${pct(best.hit)}　正命中率 ${pct(best.precision)}　正确拒绝 ${pct(best.reject)}\n`,
		);
		const cells: Array<string> = [];
		for (const floor of [0.97, 0.95, 0.9]) {
			const r = bestHitAtPrecision(points, d.labels, floor);
			const cell = r === "baseline-already-passes" ? "基线已达标" : r === null ? "做不到" : pct(r.hit);
			cells.push(cell);
			process.stdout.write(
				r === "baseline-already-passes"
					? `    正命中率 ≥ ${pct(floor)}　**基线已达标**（正例率高于门槛，全放行就够）\n`
					: r === null
						? `    正命中率 ≥ ${pct(floor)}　**做不到**\n`
						: `    正命中率 ≥ ${pct(floor)}　命中率最高 ${pct(r.hit)}（θ=${r.theta.toFixed(4)}，正确拒绝 ${pct(r.reject)}）\n`,
			);
		}
		if (!summary.has(s.key)) summary.set(s.key, new Map());
		(summary.get(s.key) as Map<string, string>).set(d.name, cells.join(" / "));
	}
}

process.stdout.write(`\n${"=".repeat(78)}\n汇总：正命中率 ≥97% / ≥95% / ≥90% 时的最高命中率\n${"=".repeat(78)}\n`);
process.stdout.write(`${"打分器".padEnd(20)}`);
for (const d of raw.datasets) process.stdout.write(` | ${d.name.padEnd(24)}`);
process.stdout.write("\n");
for (const [key, byData] of summary) {
	process.stdout.write(key.padEnd(20));
	for (const d of raw.datasets) process.stdout.write(` | ${(byData.get(d.name) ?? "—").padEnd(24)}`);
	process.stdout.write("\n");
}
process.stdout.write(
	`\n全放行基线（正例率）：${raw.datasets.map(d => `${d.name} ${pct(d.labels.filter(l => l === 1).length / d.labels.length)}`).join("　")}\n`,
);
