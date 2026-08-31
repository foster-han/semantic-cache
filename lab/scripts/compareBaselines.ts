/**
 * 自研的多闸架构 vs 主流的单阈值架构，同一把尺子。
 *
 * **对比的不是产品，是架构选择。**GPTCache 的核心是「一个 embedding 模型 + 一个
 * similarity_threshold」，那在功能上正好等于 semcache 的 ③ 单独工作；semcache 主张的是
 * ③ 后面再串一道 ④。所以只要在同一份数据上算这三档，就能回答「多加一道闸值不值」：
 *
 *   GPTCache 默认      他们的默认编码器 + 他们的默认阈值 0.8（源码 config.py）
 *   GPTCache 调优      同一个编码器，阈值扫到最优 —— 单阈值架构的上限
 *   semcache ③        换编码器，仍然单阈值
 *   semcache ③+④     ③ 召回后再过一道 cross-encoder（二维阈值）
 *
 * 三个率的定义与 probeRerankQqp.ts 一致（都在 ProbeMetrics.ts）。
 * 分数来自 `data/scores.json`，所以这个脚本**不碰模型**，秒级跑完。
 *
 *   node --experimental-strip-types scripts/compareBaselines.ts
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

/** GPTCache 的出厂默认，来自它的 gptcache/config.py */
const GPTCACHE_DEFAULT_THRESHOLD = 0.8;

function rates(scores: ReadonlyArray<number>, labels: ReadonlyArray<number>, theta: number) {
	let tp = 0;
	let fp = 0;
	const total1 = labels.filter(l => l === 1).length;
	const total0 = labels.length - total1;
	for (let i = 0; i < scores.length; i++) {
		if (scores[i] >= theta) {
			if (labels[i] === 1) tp += 1;
			else fp += 1;
		}
	}
	return {
		hit: total1 === 0 ? 0 : tp / total1,
		precision: tp + fp === 0 ? 1 : tp / (tp + fp),
		reject: total0 === 0 ? 1 : (total0 - fp) / total0,
	};
}

function f1(p: { hit: number; precision: number }): number {
	return p.hit + p.precision === 0 ? 0 : (2 * p.hit * p.precision) / (p.hit + p.precision);
}

/**
 * ③+④ 串联的二维扫描：先按 ③ 的 floor 召回，再按 ④ 的 floor 放行。
 *
 * **两道闸是 AND 关系** —— 要复用必须两道都过。所以它天然比单闸更保守：
 * 精度只可能上升、命中率只可能下降。问题从来不是「会不会更准」，而是
 * 「在同一个精度约束下，命中率是高了还是低了」。
 */
function bestChained(
	recall: ReadonlyArray<number>,
	rerank: ReadonlyArray<number>,
	labels: ReadonlyArray<number>,
	precisionFloor: number,
): { hit: number; r3: number; r4: number; precision: number; reject: number } | null {
	const grid = (xs: ReadonlyArray<number>): Array<number> => {
		const u = [...new Set(xs)].sort((a, b) => a - b);
		// 取 24 个分位点，够画出形状又不至于 O(n²) 爆掉
		return Array.from({ length: 24 }, (_, i) => u[Math.min(u.length - 1, Math.floor((i / 24) * u.length))]);
	};
	const total1 = labels.filter(l => l === 1).length;
	const total0 = labels.length - total1;
	let best: { hit: number; r3: number; r4: number; precision: number; reject: number } | null = null;
	for (const r3 of grid(recall)) {
		for (const r4 of grid(rerank)) {
			let tp = 0;
			let fp = 0;
			for (let i = 0; i < labels.length; i++) {
				if (recall[i] >= r3 && rerank[i] >= r4) {
					if (labels[i] === 1) tp += 1;
					else fp += 1;
				}
			}
			const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
			if (precision < precisionFloor) continue;
			const hit = total1 === 0 ? 0 : tp / total1;
			if (!best || hit > best.hit) {
				best = { hit, r3, r4, precision, reject: total0 === 0 ? 1 : (total0 - fp) / total0 };
			}
		}
	}
	return best;
}

const PRECISION_FLOOR = Number(process.env.PRECISION_FLOOR ?? 0.95);
const noteOf = new Map(raw.scorers.map(s => [s.key, s]));

process.stdout.write(`精度约束：正命中率 ≥ ${pct(PRECISION_FLOOR)}（改：PRECISION_FLOOR=0.9）\n`);

for (const d of raw.datasets) {
	const labels = d.labels;
	const baseline = labels.filter(l => l === 1).length / labels.length;
	process.stdout.write(`\n${"=".repeat(92)}\n${d.name}　${labels.length} 对　正例率(=全放行的正命中率) ${pct(baseline)}\n${"=".repeat(92)}\n`);
	process.stdout.write(`  ${"配置".padEnd(34)}${"阈值".padEnd(20)}${"命中率".padEnd(9)}${"正命中率".padEnd(10)}${"正确拒绝".padEnd(10)}F1\n`);

	const row = (label: string, theta: string, r: { hit: number; precision: number; reject: number }): void => {
		process.stdout.write(
			`  ${label.padEnd(34)}${theta.padEnd(20)}${pct(r.hit).padEnd(9)}${pct(r.precision).padEnd(10)}${pct(r.reject).padEnd(10)}${f1(r).toFixed(3)}\n`,
		);
	};

	// ① 主流基线：GPTCache 的默认编码器 + 它的出厂默认阈值
	const gpt = raw.scores["gptcache-albert"]?.[d.name];
	if (gpt) {
		row("GPTCache 默认（出厂阈值）", `θ=${GPTCACHE_DEFAULT_THRESHOLD}`, rates(gpt.scores, labels, GPTCACHE_DEFAULT_THRESHOLD));
	}

	// ② 各单闸编码器在精度约束下的最好工作点 —— 单阈值架构的上限
	for (const key of ["gptcache-albert", "semcache-pair", "langcache-embed"]) {
		const e = raw.scores[key]?.[d.name];
		if (!e) continue;
		const r = bestHitAtPrecision(sweep(e.scores, labels), labels, PRECISION_FLOOR);
		if (r === "baseline-already-passes") {
			row(`${key}（单闸·调优）`, "—", { hit: 1, precision: baseline, reject: 0 });
			process.stdout.write(`    ↑ 门槛低于全放行基线，这一格没有区分力\n`);
		} else if (r === null) {
			process.stdout.write(`  ${`${key}（单闸·调优）`.padEnd(34)}${"—".padEnd(20)}**做不到这个精度**\n`);
		} else {
			row(`${key}（单闸·调优）`, `θ=${r.theta.toFixed(4)}`, r);
		}
	}

	// ③ 串联：③ 用最好的那个编码器 + ④ 两个候选
	for (const ceKey of ["ce-msmarco", "ce-bge"]) {
		const r3 = raw.scores["langcache-embed"]?.[d.name];
		const r4 = raw.scores[ceKey]?.[d.name];
		if (!r3 || !r4) continue;
		const b = bestChained(r3.scores, r4.scores, labels, PRECISION_FLOOR);
		if (!b) {
			process.stdout.write(`  ${`③+④ ${ceKey}（串联）`.padEnd(34)}${"—".padEnd(20)}**做不到这个精度**\n`);
		} else {
			row(`③+④ ${ceKey}（串联）`, `③${b.r3.toFixed(3)} ④${b.r4.toFixed(3)}`, b);
		}
	}
}

/* ---------- 性能 ---------- */
process.stdout.write(`\n${"=".repeat(92)}\n性能：每对的打分耗时（本机 CPU，ONNX fp32，四份数据平均）\n${"=".repeat(92)}\n`);
for (const s of raw.scorers) {
	const per = raw.datasets.map(d => raw.scores[s.key]?.[d.name]?.msPerPair ?? 0).filter(x => x > 0);
	if (per.length === 0) continue;
	const avg = per.reduce((a, b) => a + b, 0) / per.length;
	process.stdout.write(`  ${s.key.padEnd(18)}${avg.toFixed(1).padStart(7)} ms/对　${s.kind === "bi" ? "两句各编码一次" : "一次成对前向"}　${s.note}\n`);
}
const bi = raw.scores["langcache-embed"];
const ce = raw.scores["ce-bge"];
if (bi && ce) {
	const b = raw.datasets.map(d => bi[d.name].msPerPair).reduce((a, c) => a + c, 0) / raw.datasets.length;
	const c = raw.datasets.map(d => ce[d.name].msPerPair).reduce((a, c2) => a + c2, 0) / raw.datasets.length;
	process.stdout.write(
		`\n  串联 ③+④ 的代价：每个**候选**多 ${c.toFixed(1)} ms。③ 的编码可以缓存（问题向量写入时就算好了），\n` +
			`  而 ④ 必须对每个召回候选实时跑 —— recallLimit=5 时是 ${(c * 5).toFixed(0)} ms，` +
			`相对 ③ 的 ${b.toFixed(1)} ms 是 ${(((c * 5) / b) || 0).toFixed(0)} 倍。\n` +
			`  这就是「④ 值不值」的成本侧：省下一次 LLM 生成（秒级）当然值，但它同时也是**每次未命中都要付**的固定开销。\n`,
	);
}
