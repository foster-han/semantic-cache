/**
 * 在 vCache 的数据上标 ④ 的 θq，然后在**留出的另一半**上做 A/B。
 *
 * `replayVCache.ts` 一直把 ④ 关着，因为这份数据上没有标定过的闸值，而借一个
 * （比如课程语料那轮的 en × ms-marco × 问↔问 θq=0.979）就是尺度混用。这个脚本
 * 就是把那句「不许借」变成「那就自己标一个」。
 *
 * ## 按组切，不是按行切
 *
 * **按行切会漏。** 同一个等价组的成员会横跨标定集和评测集，于是评测集里那条
 * 「该复用」的伙伴其实在标定时见过 —— θq 就是在测试集上挑的，而报出来的数字
 * 看不出这件事。所以先把 3500 个等价组扔进两个桶，再把组里的行跟着走。
 *
 * ## 标定集必须以 ③ 的工作点为条件
 *
 * ④ 在流水线里只见得到 ③ 召回回来的候选。在全集上标 θq 会把 ④ 根本没机会遇到的
 * 那类负例（两句完全不相干的话）算进去，阈值因此偏低、结论偏乐观 ——
 * 这正是 `_probe_rerankPipelined.ts` 那一轮量出来的偏差。
 *
 * 所以标定集是这么来的：在标定半区上跑一遍 ④ 关的重放，把**③ 实际放行的每一对
 * （查询, 被复用的条目）**收下来，同组的记 1、不同组的记 0。那就是 ④ 上线后
 * 真正要面对的分布。
 *
 * ## θq 按「正命中率门槛」选，不按「错误最少」选
 *
 * **两类错的代价不对称**：假命中是把错答案交出去，漏命中只是白花一次生成。
 * 而且 ③ 交给 ④ 的候选里正例本来就占八成以上（实测基线 84.2%）—— 在这种基线下
 * 「错误最少」会退化成**全放行**：实测 bge × 问↔答 那一轮的最小错误区间是
 * `0.0000~0.0000`，也就是「一个都别拦」，取中点得到 θq=0，一道恒放行的假闸。
 * 页面上看起来在工作，实际什么都不拦。
 *
 * 所以选点用 `bestHitAtPrecision`：正命中率不低于门槛的前提下，命中率最高的那个 θ。
 * 门槛达不到就**直说达不到并且不写文件** —— 那时结论是「这个 (模型 × 形态) 在这份
 * 分布上不可用」，不是「凑一个能跑的数」。
 *
 * `bestThresholdBand` 仍然算并且报出来，但只当**诊断**：它回答的是「位置定得出来吗」。
 * 区间宽就说明这份数据定不出位置，那句话该说，只是不该拿它去选 θq。
 *
 *   node --experimental-strip-types scripts/tuneVCacheRerank.ts <基准>
 *   → data/vcache-rerank-<基准>.json
 *
 * 环境变量：
 *   SPLIT_SEED     等价组分桶的 seed（默认 20260902）
 *   REPLAY_SEED    轨迹顺序的 seed（默认 20260902）
 *   RECALL_FLOOR   ③ 的工作点，单个值（默认 0.70 —— 召回最高、④ 最有活干的那一档）
 *   PRECISION_FLOOR  选 θq 的正命中率门槛（默认 0.90）。必须高于 ③ 交上来的基线，
 *                  否则「全放行」就达标，量不出 ④ 的判别力
 *   CE_TARGET      ④ 的形态：question（默认）/ answer。**换形态就是换尺度，θq 不通用**
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEncoders } from "../Models.ts";
import { bestHitAtPrecision, bestThresholdBand, pct, sweep } from "../ProbeMetrics.ts";
import { loadVCacheData, replayTrace, toReplayItem } from "../VCacheReplay.ts";
import type { ReplayItem, SurfacedPair } from "../VCacheReplay.ts";
import type { Reranker } from "../../sdk/src/index.ts";

const NAME = process.argv[2];
const SPLIT_SEED = Number(process.env.SPLIT_SEED ?? 20260902);
const TRACE_SEED = Number(process.env.REPLAY_SEED ?? 20260902);
const FLOOR = Number(process.env.RECALL_FLOOR ?? 0.7);
const TOP_K = Number(process.env.TOP_K ?? 5);
const PRECISION_FLOOR = Number(process.env.PRECISION_FLOOR ?? 0.9);

if (!NAME) {
	console.error("用法：tuneVCacheRerank.ts <基准>　基准：lmarena / search");
	process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "data", `vcache-rerank-${NAME}.json`);

const { data, items } = await loadVCacheData(NAME);
const encoders = await createEncoders();
/**
 * 一步拿到确定非空的重排器。写成 `if (x === undefined) throw` 之后再用，
 * TS 不会把那次窄化带进后面的闭包（`scorePairs` 里就报 possibly undefined）——
 * 而给它加一个 `!` 就等于把「没加载到重排器」这件事变成运行期的空指针。
 */
const reranker: Reranker =
	encoders.reranker ??
	(() => {
		throw new Error("没有加载到重排器 —— 这个脚本就是来标它的闸值的。设 CE_MODEL，或者别用 MODE=stub");
	})();
const target = encoders.models.rerankTarget;

/** 固定 seed 的 LCG —— 和另外两个脚本同一套 */
function lcg(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
}

// --- 按组分桶 ------------------------------------------------------------

const splitRnd = lcg(SPLIT_SEED);
const side = new Map<number, "calib" | "eval">();
for (const label of new Set(items.map(it => it.label as number))) {
	side.set(label, splitRnd() < 0.5 ? "calib" : "eval");
}

function traceOf(which: "calib" | "eval"): Array<ReplayItem> {
	const out = items.filter(it => side.get(it.label as number) === which).map(toReplayItem);
	const rnd = lcg(TRACE_SEED);
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

const calibTrace = traceOf("calib");
const evalTrace = traceOf("eval");

// --- 编码器（跨三趟共用一份 memo，本地模型跑一遍就够）--------------------

const embedCache = new Map<string, Array<number>>();
async function embedQuestions(texts: ReadonlyArray<string>): Promise<Array<Array<number>>> {
	const missing = texts.filter(t => !embedCache.has(t));
	if (missing.length > 0) {
		const fresh = await encoders.embedQuestions(missing);
		missing.forEach((t, i) => embedCache.set(t, fresh[i]));
	}
	return texts.map(t => embedCache.get(t) as Array<number>);
}

console.log(`${data.source}`);
console.log(
	`  ${items.length} 条 / ${side.size} 个等价组　按组切：标定 ${calibTrace.length} 条、评测 ${evalTrace.length} 条（seed ${SPLIT_SEED}）`,
);
console.log(`  ③ 工作点 floor=${FLOOR} top-${TOP_K}　④ ${encoders.models.rerank} · ${target === "answer" ? "问↔答" : "问↔问"}`);
if (data.labelNoise !== undefined) console.log(`  ⚠ ${data.labelNoise}`);
console.log();

// --- 标定：收 ③ 放行的对子，用 ④ 的算子打分 ------------------------------

const calib = await replayTrace({
	items: calibTrace,
	scopeKey: `vcache:${NAME}:calib`,
	floor: FLOOR,
	topK: TOP_K,
	embedQuestions,
	collectPairs: true,
});

/**
 * **打分必须用 ④ 上线后会用的那个算子**，形态也要一样。问↔问比的是两个问句，
 * 问↔答拿的是缓存里那条**旧答案** —— 同一个模型换个形态就是另一组数，
 * 所以 θq 和 target 是捆在一起的一个值。
 */
async function scorePairs(pairs: ReadonlyArray<SurfacedPair>): Promise<Array<number>> {
	const out: Array<number> = [];
	for (const p of pairs) {
		out.push(await reranker.score(p.queryPrompt, target === "answer" ? p.candidateAnswer : p.candidatePrompt));
	}
	return out;
}

const calibPairs = calib.pairs;
if (calibPairs.length < 30) {
	throw new Error(
		`标定半区只放行了 ${calibPairs.length} 对 —— 太少，标不出东西。` +
			"调低 RECALL_FLOOR，或者取一份更大的样本。**不写文件。**",
	);
}
const calibScores = await scorePairs(calibPairs);
const calibLabels = calibPairs.map(p => (p.same ? 1 : 0));
const baseline = calibLabels.filter(l => l === 1).length / calibLabels.length;

console.log(`标定半区：③ 放行 ${calibPairs.length} 对，其中同组 ${calibLabels.filter(l => l === 1).length} 对`);
console.log(`  **④ 的基线是 ${pct(baseline)}** —— 什么都放行就有这个正命中率，④ 得比它强才算有用`);

const points = sweep(calibScores, calibLabels);
for (const floorP of [0.9, 0.95]) {
	const best = bestHitAtPrecision(points, calibLabels, floorP);
	if (best === "baseline-already-passes") console.log(`  正命中率 ≥ ${pct(floorP)}：基线已经达标，这个门槛量不出判别力`);
	else if (best === null) console.log(`  正命中率 ≥ ${pct(floorP)}：**达不到** —— 任何阈值都做不到这个精度`);
	else console.log(`  正命中率 ≥ ${pct(floorP)}：θ=${best.theta.toFixed(4)} 时命中率 ${pct(best.hit)}`);
}

/**
 * 区间只当诊断。**不拿它选 θq** —— 见文件头：高基线下最小错误准则会退化成全放行，
 * 那是一道假闸而不是一个阈值。
 */
const band = bestThresholdBand(calibScores, calibLabels);
const wide = band.hi - band.lo > 0.2;
console.log(
	`  诊断 · 错误最少的阈值区间 ${band.lo.toFixed(4)}~${band.hi.toFixed(4)}（宽 ${(band.hi - band.lo).toFixed(4)}，${band.errors} 个错）`,
);
if (band.hi <= Math.min(...calibScores)) {
	console.log("  ⚠ 那个区间就是「一个都别拦」—— 在这个基线下最小错误准则没有意义，所以 θq 不从它来");
} else if (wide) {
	console.log("  ⚠ 区间很宽 —— **这份数据定不出位置**");
}

const chosen = bestHitAtPrecision(points, calibLabels, PRECISION_FLOOR);
if (chosen === "baseline-already-passes") {
	throw new Error(
		`PRECISION_FLOOR=${PRECISION_FLOOR} 低于 ③ 交上来的基线 ${pct(baseline)} —— 全放行就达标，` +
			"这个门槛量不出 ④ 的判别力，跑出来的 A/B 是假的。把门槛提到基线以上再跑。**不写文件。**",
	);
}
if (chosen === null) {
	throw new Error(
		`(${encoders.models.rerank} × ${target === "answer" ? "问↔答" : "问↔问"}) 在这份数据上` +
			`达不到 ${pct(PRECISION_FLOOR)} 的正命中率 —— **任何阈值都不行**。结论是这个组合在这个分布上不可用，` +
			"不是「凑一个能跑的数」。降 PRECISION_FLOOR，或者换模型/形态。**不写文件。**",
	);
}
const thetaQ = Number(chosen.theta.toFixed(4));
console.log(`  → θq=${thetaQ}（正命中率 ≥ ${pct(PRECISION_FLOOR)} 前提下命中率最高的那个点：${pct(chosen.hit)}）`);
console.log();

// --- 评测：同一个 floor，④ 关 vs ④ 开 -----------------------------------

const off = await replayTrace({
	items: evalTrace,
	scopeKey: `vcache:${NAME}:eval-off`,
	floor: FLOOR,
	topK: TOP_K,
	embedQuestions,
});
const on = await replayTrace({
	items: evalTrace,
	scopeKey: `vcache:${NAME}:eval-on`,
	floor: FLOOR,
	topK: TOP_K,
	embedQuestions,
	rerank: { scorer: reranker, thetaQ, target },
	collectPairs: true,
});

const rows = [
	["④ 关", off],
	[`④ 开 θq=${thetaQ}`, on],
] as const;
console.log("评测半区（标定时没见过这些组）");
console.log(["配置", "正命中", "假命中", "漏命中", "正命中率", "召回率", "省下"].map((h, i) => h.padStart(i === 0 ? 16 : 9)).join(""));
for (const [label, r] of rows) {
	const hits = r.trueHits + r.falseHits;
	console.log(
		[
			label,
			String(r.trueHits),
			String(r.falseHits),
			String(r.missedReuse),
			hits === 0 ? "—" : pct(r.trueHits / hits),
			r.reusable === 0 ? "—" : pct(r.trueHits / r.reusable),
			r.savedSeconds > 0 ? `${r.savedSeconds.toFixed(0)}s` : "—",
		].map((c, i) => c.padStart(i === 0 ? 16 : 9)).join(""),
	);
}

const dFalse = on.falseHits - off.falseHits;
const dTrue = on.trueHits - off.trueHits;
/**
 * **这两个数一起看才有意义。** 少掉的假命中是 ④ 的收益，少掉的正命中是它的代价 ——
 * 一道恒拦下的闸假命中永远是 0。先前 26 条场景上的结论「④ 端到端零精度收益、
 * 砍掉 2 次合法复用」就是这么读出来的。
 */
console.log(
	`\n④ 的净效果：假命中 ${off.falseHits} → ${on.falseHits}（${dFalse >= 0 ? "+" : ""}${dFalse}）　` +
		`正命中 ${off.trueHits} → ${on.trueHits}（${dTrue >= 0 ? "+" : ""}${dTrue}）`,
);
if (dFalse === 0 && dTrue === 0) console.log("  在这个半区上 ④ 一条都没改变 —— 要么它没用，要么 θq 落在了分布外面");
else if (dFalse < 0 && dTrue === 0) console.log("  **纯赚**：只砍掉了错的，没有误伤合法复用");
else if (dFalse < 0) console.log(`  拦掉 ${-dFalse} 次假命中，代价是误伤 ${-dTrue} 次合法复用 —— 值不值是产品决定，不是脚本决定`);
else console.log("  ⚠ 假命中没有下降 —— θq 在这个半区上失配，别把它写进标定表");

// 泛化差：同一套算子在评测半区上本该取什么阈值
const evalPairs = on.pairs;
if (evalPairs.length >= 30) {
	const evalScores = await scorePairs(evalPairs);
	const evalBand = bestThresholdBand(evalScores, evalPairs.map(p => (p.same ? 1 : 0)));
	console.log(
		`\n泛化差：评测半区自己的最优区间是 ${evalBand.lo.toFixed(4)}~${evalBand.hi.toFixed(4)}，` +
			`标定半区给的是 ${thetaQ}${thetaQ >= evalBand.lo && thetaQ <= evalBand.hi ? "（落在里面）" : "（**落在外面**）"}`,
	);
}

/**
 * **结果按 (重排模型 × 形态) 存，不按文件名存。**
 *
 * 先前两趟都写 `vcache-rerank-lmarena.json`，于是 `ms-marco × 问↔问` 的结果被
 * `bge × 问↔答` 整个覆盖，文件里那份数看着完好、其实是另一个组合的 ——
 * `data/README.md` 里 `scores.json` 那条坑（「`semcache-pair` 这个 key 曾经挂着
 * 上一个模型的分数」）一字不改地重演了一遍。θq 属于 (模型 × 形态)，存法就得跟着它。
 */
const configKey = `${encoders.models.rerank ?? "无重排器"} × ${target === "answer" ? "问↔答" : "问↔问"}`;
interface TuningFile {
	source: string;
	benchmark: string;
	byConfig: Record<string, unknown>;
}
let file: TuningFile = { source: data.source, benchmark: NAME, byConfig: {} };
try {
	const prev = JSON.parse(await readFile(OUT, "utf8")) as Partial<TuningFile>;
	// 换了数据文件就别混进同一张表 —— 那等于把两轮取样的结果并排放
	if (prev.source === data.source && prev.byConfig !== undefined) file = prev as TuningFile;
} catch {
	// 第一次跑，没有旧文件
}

file.byConfig[configKey] = {
	splitSeed: SPLIT_SEED,
	traceSeed: TRACE_SEED,
	floor: FLOOR,
	topK: TOP_K,
	rerank: {
		model: encoders.models.rerank,
		target,
		thetaQ,
		chosenBy: `bestHitAtPrecision(${PRECISION_FLOOR}) —— 不是最小错误区间中点，见脚本头`,
		hitAtChosen: chosen.hit,
		precisionFloor: PRECISION_FLOOR,
		band,
		bandIsWide: wide,
	},
	calibration: {
		queries: calibTrace.length,
		surfacedPairs: calibPairs.length,
		positives: calibLabels.filter(l => l === 1).length,
		baselinePrecision: baseline,
		note: "标定集 = ③ 在 floor 上实际放行的候选，不是全集 —— 见 _probe_rerankPipelined.ts",
	},
	evaluation: {
		queries: evalTrace.length,
		off: { trueHits: off.trueHits, falseHits: off.falseHits, missedReuse: off.missedReuse, reusable: off.reusable, savedSeconds: off.savedSeconds },
		on: { trueHits: on.trueHits, falseHits: on.falseHits, missedReuse: on.missedReuse, reusable: on.reusable, savedSeconds: on.savedSeconds },
		deltaFalseHits: dFalse,
		deltaTrueHits: dTrue,
	},
	examplesCaught: off.examples.filter(e => !on.examples.some(x => x.query === e.query)).slice(0, 10),
	notTested: [
		"① scope 门控 —— 这份数据没有用户/租户维度，全程单 scope",
		"这一轮跑的是 ①②③④ —— ⑤ 资料版本已于 2026-09 从 SDK 移除",
	],
	labelNoise: data.labelNoise,
};

await writeFile(OUT, JSON.stringify(file, null, "\t"), "utf8");
console.log(`\n写入 ${OUT} 的 byConfig["${configKey}"]（同文件里现有 ${Object.keys(file.byConfig).length} 个组合）`);
