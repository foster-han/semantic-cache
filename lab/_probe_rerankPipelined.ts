/**
 * ④ 的评估必须**以 ③ 的工作点为条件**。
 *
 * `probeRerankQqp.ts` 在整个 QQP 上评 ④，但 ④ 在流水线里只见到 ③ 召回回来的候选 ——
 * 而 QQP 的负例大多是完全不同的两个问题（`Why are people so obsessed with having a
 * girlfriend` ／ `How can a single male have a child`），那一类 ③ 的召回下限早就挡掉了。
 * 这正是 18 对那轮特意排除的一类（`_probe_ce4.ts` 的判据修正），换到 QQP 后这个洞察丢了。
 *
 * 所以这里扫多个 ③ floor，看 ④ 在**它实际会面对的那个分布**上是什么样 ——
 * 顺带量出全集评估高估了多少。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AutoModelForSequenceClassification, AutoTokenizer, pipeline } from "@huggingface/transformers";
import { cosine } from "./Models.ts";
import { bestHitAtPrecision, pct, scoreFromLogits, sweep } from "./ProbeMetrics.ts";

const here = dirname(fileURLToPath(import.meta.url));
interface Pair {
	readonly question1: string;
	readonly question2: string;
	readonly label: number;
}
const raw = JSON.parse(await readFile(join(here, "data", "qqp.json"), "utf8")) as { pairs: Array<Pair> };
const pairs = raw.pairs;

/** ③ 用表现更好的那个编码器 —— 要看的是「合理配置下 ④ 的处境」，不是叠加两个坏配置 */
const RECALL_MODEL = "redis/langcache-embed-v1";
process.stdout.write(`③ ${RECALL_MODEL}（cls）　④ 两个候选　共 ${pairs.length} 对\n`);
const ex = await pipeline("feature-extraction", RECALL_MODEL, { dtype: "fp32" });
const cos: Array<number> = [];
for (let i = 0; i < pairs.length; i += 64) {
	const chunk = pairs.slice(i, i + 64);
	const out = await ex(chunk.flatMap(p => [p.question1, p.question2]), { pooling: "cls", normalize: true });
	const v = out.tolist() as Array<Array<number>>;
	for (let k = 0; k < chunk.length; k++) cos.push(cosine(v[k * 2], v[k * 2 + 1]));
}

/** 一行摘要：三个正命中率门槛下各自的最高命中率。基线判断在 bestHitAtPrecision 里 */
function curve(scores: ReadonlyArray<number>, labels: ReadonlyArray<number>): string {
	if (labels.every(l => l === 1) || labels.every(l => l === 0)) return "    （子集里只剩一类标签，测不了）";
	const points = sweep(scores, labels);
	const at = (floor: number): string => {
		const r = bestHitAtPrecision(points, labels, floor);
		return r === "baseline-already-passes" ? "基线已达标" : r === null ? "做不到" : pct(r.hit);
	};
	return `    ≥97% → ${at(0.97).padStart(10)}　≥95% → ${at(0.95).padStart(10)}　≥90% → ${at(0.9).padStart(10)}`;
}

for (const [label, id] of [
	["ms-marco-L6（默认）", "Xenova/ms-marco-MiniLM-L-6-v2"],
	["bge-reranker-base", "Xenova/bge-reranker-base"],
] as const) {
	process.stdout.write(`\n=== ④ ${label} ===\n`);
	const tok = await AutoTokenizer.from_pretrained(id);
	const model = await AutoModelForSequenceClassification.from_pretrained(id);
	const ce: Array<number> = [];
	for (const p of pairs) {
		const inp = await tok(p.question1, { text_pair: p.question2, padding: true, truncation: true });
		const { logits } = await model(inp);
		ce.push(scoreFromLogits(Array.from(logits.data as ArrayLike<number>, Number), logits.dims as ReadonlyArray<number>));
	}
	// floor=0 就是全集，也就是 probeRerankQqp 现在报的那个数
	for (const floor of [0, 0.5, 0.6, 0.7, 0.8, 0.85]) {
		const idx = pairs.map((_, i) => i).filter(i => cos[i] >= floor);
		const kept1 = idx.filter(i => pairs[i].label === 1).length;
		const tag = floor === 0 ? "全集（现在报的）" : `③ floor ${floor.toFixed(2)}`;
		process.stdout.write(
			`  ${tag.padEnd(18)} 通过 ${String(idx.length).padStart(4)}/${pairs.length}　` +
				`全放行基线正命中率 ${((kept1 / idx.length) * 100).toFixed(1)}%\n` +
				`${curve(idx.map(i => ce[i]), idx.map(i => pairs[i].label))}\n`,
		);
	}
}
