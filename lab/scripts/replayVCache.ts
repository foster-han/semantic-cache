/**
 * 轨迹重放：把 `data/vcache-*.json` 里的查询**按顺序**放进一个空缓存，让它自己长起来，
 * 每一条都记下「这次该不该复用」。
 *
 * **这和 `benchPairs.ts` 不是一件事。** 那边是给两句话打分、看阈值切得对不对；
 * 这边是端到端：缓存里有什么、命中了哪一条、复用得对不对，全都取决于前面那几千条
 * 怎么走的。句对数据答不了「复用的那个答案对不对」，因为它没有等价组标注。
 *
 * ## 判据
 *
 * 每条查询按 (命中没有 × 复用的那条同不同组) 分进四格：
 *
 *   命中且同组     正命中
 *   命中但不同组   **假命中** ← 之前唯一在测的那个量
 *   没命中但缓存里已有同组的   漏命中
 *   没命中且缓存里也没有       正确拒绝
 *
 * 「缓存里已有同组的」是**到达那一刻**的状态，所以它是一个真 oracle，不是事后诸葛。
 *
 * ## 正命中有上限，先算出来免得误读
 *
 * 每组第一次出现必然是 miss，所以**正命中**的上限 = (行数 − 组数) / 行数：
 * lmarena 25.4%、search 11.6%。在 lmarena 上正命中占到 25% 是满分，不是平庸。
 *
 * **这个上限管的是正命中，不是命中率。** 假命中不受它约束 —— 复用一条不同组的
 * 条目照样算一次命中，所以命中率完全可以超过上限，而超出去的那部分全是错的。
 * 先前这一行标的是「命中率上限」，实测 lmarena 在 floor=0.70 上命中率 29.9%
 * 越过了 25.4%，那不是算错，是这两个量本来就不是一回事。
 *
 * ## 这一轮没有测到的
 *
 * - **① scope 门控**：这份数据没有用户/租户维度，全程单 scope。
 * - **⑤ 资料版本**：没有资料，更没有版本，显式关掉。
 * - **「没有依据的答案不写入」这条不变式**：SDK 的 `cacheable()` 要求 `sourceIds` 非空，
 *   而这份数据的答案是上游预先生成的、不依附任何语料。这里给每条查询造一个
 *   `vcache:<行 id>` 当依据 —— **那是个占位，不是真依据**。不造的话缓存一条都写不进去，
 *   命中率恒为 0 而且不报错；造了就等于这条不变式在本轮没有被测到。两害相权，
 *   选能测到 ②③④ 的那个，并把这句话写进结果文件。
 *
 * ## 阈值不许借
 *
 * `RECALL_FLOOR` 默认是**一串值**，输出因此是一条曲线而不是一个数 —— 这份数据上
 * 没有标定过的召回下限，随手填一个就是拿课程语料的尺度去量真实流量。
 * ④ 同理：默认关闭，要开就得显式给 `THETA_Q`，那时由你为这个数负责。
 *
 *   node --experimental-strip-types scripts/replayVCache.ts <基准> [条数]
 *   → data/vcache-replay-<基准>.json
 *
 * 环境变量：
 *   REPLAY_SEED    轨迹顺序的洗牌 seed（默认 20260902）。**顺序决定一切** ——
 *                  同组挨着放命中率接近上限，散开放才是在量召回
 *   REPLAY_ENC     local（默认，跑 lab 的本地模型）| file:<列名>（用上游预算好的向量，
 *                  例如 file:gte —— 要先用 VCACHE_EMB=gte 重取一份数据）
 *   RECALL_FLOOR   召回下限，逗号分隔（默认 0.60,0.65,…,0.95）
 *   THETA_Q        ④ 的闸值。给了才开 ④
 *   TOP_K          ③ 召回几条（默认 5）
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryCacheStore, createSemanticCache } from "../../sdk/src/index.ts";
import type { CachePrompt, Chunk } from "../../sdk/src/index.ts";
import { createEncoders } from "../Models.ts";
import { pct } from "../ProbeMetrics.ts";

interface DataItem {
	readonly id: unknown;
	readonly label: number | null;
	readonly cluster?: number;
	readonly prompt: string;
	readonly responses?: Record<string, string>;
	readonly latencies?: Record<string, number>;
	readonly emb?: Record<string, Array<number>>;
}

interface DataFile {
	readonly source: string;
	readonly benchmark: string;
	readonly labelColumn: string | null;
	readonly labelNoise?: string;
	readonly rows: number;
	readonly items: ReadonlyArray<DataItem>;
}

const NAME = process.argv[2];
const LIMIT = process.argv[3] === undefined ? Number.POSITIVE_INFINITY : Number(process.argv[3]);
const SEED = Number(process.env.REPLAY_SEED ?? 20260902);
const ENC_MODE = process.env.REPLAY_ENC ?? "local";
const TOP_K = Number(process.env.TOP_K ?? 5);
const THETA_Q = process.env.THETA_Q === undefined ? null : Number(process.env.THETA_Q);
const FLOORS = (process.env.RECALL_FLOOR ?? "0.60,0.65,0.70,0.75,0.80,0.85,0.90,0.95")
	.split(",")
	.map(s => Number(s.trim()))
	.filter(x => Number.isFinite(x));

if (!NAME) {
	console.error("用法：replayVCache.ts <基准> [条数]　基准：lmarena / search / classification / combo");
	process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const IN = join(here, "..", "data", `vcache-${NAME}.json`);
const OUT = join(here, "..", "data", `vcache-replay-${NAME}.json`);

const data = JSON.parse(await readFile(IN, "utf8")) as DataFile;
if (data.labelColumn === null) {
	throw new Error(
		`${IN} 没有等价组列（${data.benchmark}）—— 没有 oracle 就判不出正命中和假命中，` +
			"这个脚本对它无能为力。判据只能落回比答案字符串，那是另一套东西。",
	);
}

/** 固定 seed 的 LCG —— 和取样脚本同一套 */
let rngState = SEED;
function rnd(): number {
	rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
	return rngState / 0x7fffffff;
}

const items = data.items.filter(it => it.label !== null && it.label >= 0).slice(0, LIMIT);
/** Fisher-Yates，用同一个 LCG —— 顺序是这个实验的自变量之一，必须可复现 */
const trace = [...items];
for (let i = trace.length - 1; i > 0; i--) {
	const j = Math.floor(rnd() * (i + 1));
	[trace[i], trace[j]] = [trace[j], trace[i]];
}

// --- 编码器 --------------------------------------------------------------

const encoders = await createEncoders();

/**
 * `PairEncoder` 是注入的，所以「用上游预算好的向量」只是换一张查表 —— 一个模型都不加载。
 * 这条路存在的意义是 ③ 的编码器横评：gte-large-en-v1.5 和 e5-large-v2 在这 5 万条真实
 * 流量上已经算好了，不用下模型也不用推理。
 *
 * **只换 ③。** ④ 是 cross-encoder，要的是两段文本拼起来送进模型，没有「各自编码再比」
 * 这一步，所以它仍然走本地重排器。
 */
const embedCache = new Map<string, Array<number>>();
let embedCalls = 0;

function lookupEncoder(column: string): (texts: ReadonlyArray<string>) => Promise<Array<Array<number>>> {
	const table = new Map<string, Array<number>>();
	for (const it of data.items) {
		const v = it.emb?.[column];
		if (v !== undefined) table.set(it.prompt, v);
	}
	if (table.size === 0) {
		throw new Error(
			`这份数据里没有 emb.${column} —— 取样时没留向量。重取一份：` +
				`VCACHE_EMB=${column} node --experimental-strip-types scripts/fetchVCache.ts ${NAME} <条数>`,
		);
	}
	return async texts =>
		texts.map(t => {
			const v = table.get(t);
			// 查不到就是错，别悄悄回落到 0 向量 —— 那会让余弦全部为 0，看起来像「什么都不像」
			if (v === undefined) throw new Error(`emb.${column} 里没有这一条的向量：${t.slice(0, 60)}…`);
			return v;
		});
}

const rawEmbed =
	ENC_MODE === "local"
		? (texts: ReadonlyArray<string>) => encoders.embedQuestions(texts)
		: lookupEncoder(ENC_MODE.replace(/^file:/u, ""));

/** 同一句话在一轮扫描里会被编码很多次（每个 floor 重跑一遍）—— memo 掉，否则本地模型跑到天亮 */
async function embedQuestions(texts: ReadonlyArray<string>): Promise<Array<Array<number>>> {
	const missing = texts.filter(t => !embedCache.has(t));
	if (missing.length > 0) {
		embedCalls += missing.length;
		const fresh = await rawEmbed(missing);
		missing.forEach((t, i) => embedCache.set(t, fresh[i]));
	}
	return texts.map(t => embedCache.get(t) as Array<number>);
}

// --- 一次重放 ------------------------------------------------------------

interface Outcome {
	readonly floor: number;
	readonly gate4: boolean;
	readonly queries: number;
	/** 到达时缓存里已有同组条目的查询数 —— 命中率的上限，也是漏命中的分母 */
	readonly reusable: number;
	readonly trueHits: number;
	readonly falseHits: number;
	readonly missedReuse: number;
	readonly correctRejects: number;
	/** 未命中被哪道闸拦下 */
	readonly exitedAt: Record<string, number>;
	/** 正命中省下的生成耗时（秒）—— 只有 lmarena 带真耗时 */
	readonly savedSeconds: number;
	readonly examples: ReadonlyArray<{ query: string; reused: string; queryLabel: number; reusedLabel: number }>;
}

async function replay(floor: number, gate4: boolean): Promise<Outcome> {
	// `LabEncoders.reranker` 是可选属性，不是 `| null` —— 取出来判一次，别在下面重复窄化
	const reranker = encoders.reranker;
	if (gate4 && reranker === undefined) throw new Error("要开 ④ 但没有加载到重排器 —— 检查 CE_MODEL");
	const cache = createSemanticCache({
		recall: {
			scorer: { embedQuestions },
			thresholds: { floor },
			calibratedOn: `未在本数据上标定 —— 这一轮是扫描，floor=${floor} 只是曲线上的一个点`,
		},
		rerank:
			gate4 && reranker !== undefined && THETA_Q !== null
				? {
						scorer: reranker,
						thresholds: { floor: THETA_Q, target: encoders.models.rerankTarget },
						calibratedOn: `显式 THETA_Q=${THETA_Q}，未在本数据上标定 —— 由调用方负责`,
					}
				: undefined,
		store: createMemoryCacheStore(),
		/**
		 * 造一个占位依据。**这不是真检索** —— 见文件头那条说明：不造的话
		 * `cacheable()` 会拒绝写入每一条答案，缓存永远是空的，而且一声不吭。
		 */
		retriever: { retrieve: async (text: string): Promise<Array<Chunk>> => [{ id: `vcache:${text}`, text }] },
		// 单 scope：这份数据没有用户/租户维度，① 因此没有参与
		scope: () => ({ key: `vcache:${NAME}`, shared: true, org: "lab" }),
		sourceVersion: () => "v1",
		gates: { sourceVersion: false },
		recallLimit: TOP_K,
		ttlMs: null,
	});

	/** entryId → 写它的那条查询属于哪个组。命中之后就靠它判对错 */
	const labelByEntry = new Map<string, number>();
	/** 缓存里现在有哪些组 —— oracle。没有驱逐，所以只增不减 */
	const labelsInCache = new Set<number>();

	let reusable = 0;
	let trueHits = 0;
	let falseHits = 0;
	let missedReuse = 0;
	let correctRejects = 0;
	let savedSeconds = 0;
	const exitedAt: Record<string, number> = {};
	const examples: Array<{ query: string; reused: string; queryLabel: number; reusedLabel: number }> = [];
	const promptByEntry = new Map<string, string>();

	for (const it of trace) {
		const label = it.label as number;
		// **到达那一刻**的状态，必须在 resolve 之前读
		const hadPartner = labelsInCache.has(label);
		if (hadPartner) reusable += 1;

		const prompt: CachePrompt = {
			matchText: it.prompt,
			retrievalText: it.prompt,
			redacted: false,
			context: {},
		};
		const answer = it.responses === undefined ? String(it.id) : Object.values(it.responses)[0];
		const result = await cache.resolve(prompt, async (_p, chunks) => ({
			kind: "answer" as const,
			answer,
			sourceIds: chunks.map(c => c.id),
		}));

		if (result.outcome === "generated") {
			if (hadPartner) missedReuse += 1;
			else correctRejects += 1;
			const at = result.exitedAt === null ? "没被拦，只是没候选" : `第 ${result.exitedAt} 道闸`;
			exitedAt[at] = (exitedAt[at] ?? 0) + 1;
			if (result.entryId !== null) {
				labelByEntry.set(result.entryId, label);
				promptByEntry.set(result.entryId, it.prompt);
				labelsInCache.add(label);
			}
			continue;
		}

		// 命中。对错只看组，不看答案文本 —— 答案是上游生成的，两条同组的答案本来就不一样
		const reusedLabel = result.entryId === null ? null : (labelByEntry.get(result.entryId) ?? null);
		if (reusedLabel === label) {
			trueHits += 1;
			savedSeconds += it.latencies === undefined ? 0 : (Object.values(it.latencies)[0] ?? 0);
		} else {
			falseHits += 1;
			if (examples.length < 20) {
				examples.push({
					query: it.prompt,
					reused: result.entryId === null ? "（没有 entryId）" : (promptByEntry.get(result.entryId) ?? "（未知条目）"),
					queryLabel: label,
					reusedLabel: reusedLabel ?? -1,
				});
			}
		}
	}

	return {
		floor,
		gate4,
		queries: trace.length,
		reusable,
		trueHits,
		falseHits,
		missedReuse,
		correctRejects,
		exitedAt,
		savedSeconds,
		examples,
	};
}

// --- 跑 ------------------------------------------------------------------

const groups = new Set(items.map(it => it.label));
/** 每组第一次必然 miss —— 这是**正命中**的上限。命中率不受它约束，见文件头 */
const ceiling = (items.length - groups.size) / items.length;

console.log(`${data.source}`);
console.log(
	`  ${items.length} 条查询　${groups.size} 个等价组　正命中上限 ${pct(ceiling)}（每组第一次必然是 miss；` +
		"命中率可以越过它 —— 越出去的都是假命中)",
);
console.log(`  轨迹 seed ${SEED}　③ 编码器 ${ENC_MODE === "local" ? `本地 ${encoders.models.pair}` : ENC_MODE}　top-${TOP_K}`);
console.log(
	`  ④ ${THETA_Q === null ? "关（没给 THETA_Q —— 这份数据上没有标定过的闸值，不许借）" : `开，θq=${THETA_Q}（显式给的，未在本数据上标定）`}`,
);
console.log("  ① 未参与（单 scope，数据没有用户维度）　⑤ 关（没有资料版本）");
if (data.labelNoise !== undefined) console.log(`  ⚠ ${data.labelNoise}`);
console.log();

const runs: Array<Outcome> = [];
for (const floor of FLOORS) {
	runs.push(await replay(floor, false));
	if (THETA_Q !== null) runs.push(await replay(floor, true));
}

const head = ["下限", "④", "命中率", "正命中占比", "正命中率", "召回率", "正命中", "假命中", "漏命中", "省下"];
console.log(head.map((h, i) => h.padStart(i === 0 ? 6 : 8)).join(""));
for (const r of runs) {
	const hits = r.trueHits + r.falseHits;
	const cells = [
		r.floor.toFixed(2),
		r.gate4 ? "开" : "关",
		pct(hits / r.queries),
		// 正命中占全部查询的比例 —— 和上限同一根尺子，这一列才是能跟 ceiling 比的那个
		pct(r.trueHits / r.queries),
		hits === 0 ? "—" : pct(r.trueHits / hits),
		r.reusable === 0 ? "—" : pct(r.trueHits / r.reusable),
		String(r.trueHits),
		String(r.falseHits),
		String(r.missedReuse),
		r.savedSeconds === 0 ? "—" : `${r.savedSeconds.toFixed(0)}s`,
	];
	console.log(cells.map((c, i) => c.padStart(i === 0 ? 6 : 8)).join(""));
}

/**
 * **命中率和正命中率要一起看。** 一个永远不命中的缓存假命中率天然是 0 —— 这是
 * `_hitrate.ts` 当初存在的理由，换到这份数据上一字不改地成立。
 */
const best = runs.filter(r => r.trueHits + r.falseHits > 0);
if (best.length > 0) {
	const top = best.reduce((a, b) => (b.trueHits > a.trueHits ? b : a));
	console.log(
		`\n正命中最多的一档：下限 ${top.floor.toFixed(2)} ④${top.gate4 ? "开" : "关"} —— ` +
			`${top.trueHits}/${top.reusable} 条该复用的复用了，代价是 ${top.falseHits} 次假命中`,
	);
	if (top.examples.length > 0) {
		console.log("  假命中示例：");
		for (const e of top.examples.slice(0, 3)) {
			console.log(`    问：${e.query.replace(/\s+/gu, " ").slice(0, 70)}　[组 ${e.queryLabel}]`);
			console.log(`    复用：${e.reused.replace(/\s+/gu, " ").slice(0, 70)}　[组 ${e.reusedLabel}]`);
		}
	}
}
console.log(`\n编码 ${embedCalls} 条（其余命中 memo）`);

await writeFile(
	OUT,
	JSON.stringify(
		{
			source: data.source,
			benchmark: NAME,
			queries: items.length,
			groups: groups.size,
			trueHitCeiling: ceiling,
			ceilingNote: "上限管的是正命中占比，不是命中率 —— 假命中不受它约束",
			traceSeed: SEED,
			encoder: ENC_MODE === "local" ? { mode: "local", model: encoders.models.pair } : { mode: ENC_MODE },
			reranker: THETA_Q === null ? null : { model: encoders.models.rerank, target: encoders.models.rerankTarget, thetaQ: THETA_Q },
			topK: TOP_K,
			notTested: [
				"① scope 门控 —— 这份数据没有用户/租户维度，全程单 scope",
				"⑤ 资料版本 —— 没有资料，更没有版本",
				"「没有依据的答案不写入」—— 依据是造出来的占位（vcache:<prompt>），这条不变式本轮没测到",
			],
			labelNoise: data.labelNoise,
			runs: runs.map(r => ({ ...r, examples: r.examples.slice(0, 20) })),
		},
		null,
		"\t",
	),
	"utf8",
);
console.log(`写入 ${OUT}`);
