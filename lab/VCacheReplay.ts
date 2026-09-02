/**
 * 轨迹重放的核心循环。**两个脚本共用这一份**：`scripts/replayVCache.ts` 出曲线，
 * `scripts/tuneVCacheRerank.ts` 标 θq 再做 A/B。
 *
 * 抽出来的理由不是省行数，是那两件事必须跑在**同一个循环**上。④ 的标定集只有
 * 「③ 在某个 floor 上实际放行的那些候选」才算数（见 `_probe_rerankPipelined.ts`：
 * 在全集上评 ④ 会把它没机会见到的那类负例算进去，结论整个偏乐观）。抄一份循环出来
 * 标定，就等于允许两边慢慢长得不一样，而**被信任的总是错的那一份**。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryCacheStore, createSemanticCache } from "../sdk/src/index.ts";
import type { CachePrompt, Chunk, Reranker, RerankTarget } from "../sdk/src/index.ts";

/** `scripts/fetchVCache.ts` 写出来的那份文件。字段名跟着它走 */
export interface VCacheDataItem {
	readonly id: unknown;
	readonly label: number | null;
	readonly cluster?: number;
	readonly prompt: string;
	readonly responses?: Record<string, string>;
	readonly latencies?: Record<string, number>;
	readonly emb?: Record<string, Array<number>>;
}

export interface VCacheData {
	readonly source: string;
	readonly benchmark: string;
	readonly labelColumn: string | null;
	readonly labelNoise?: string;
	readonly rows: number;
	readonly items: ReadonlyArray<VCacheDataItem>;
}

/**
 * 读一份取样文件，并**在这里就把没有标注的挡掉**。
 *
 * 负 label 是 combo 那份的「不该命中」标记，上游语义没查实（README 说是标记，
 * `benchmark.py` 却照常做等值比较）—— 当等价组用会凭空造出一批「正命中」。
 */
export async function loadVCacheData(name: string): Promise<{ data: VCacheData; items: Array<VCacheDataItem> }> {
	const here = dirname(fileURLToPath(import.meta.url));
	const path = join(here, "data", `vcache-${name}.json`);
	const data = JSON.parse(await readFile(path, "utf8")) as VCacheData;
	if (data.labelColumn === null) {
		throw new Error(
			`${path} 没有等价组列（${data.benchmark}）—— 没有 oracle 就判不出正命中和假命中。` +
				"判据只能落回比答案字符串，那是另一套东西。",
		);
	}
	return { data, items: data.items.filter(it => it.label !== null && it.label >= 0) };
}

/** 取样文件的一行 → 重放要的那三样。答案缺失时用行 id 顶上，只影响 ④ 的问↔答形态 */
export function toReplayItem(it: VCacheDataItem): ReplayItem {
	return {
		label: it.label as number,
		prompt: it.prompt,
		answer: it.responses === undefined ? String(it.id) : (Object.values(it.responses)[0] ?? String(it.id)),
		latencySeconds: it.latencies === undefined ? 0 : (Object.values(it.latencies)[0] ?? 0),
	};
}

export interface ReplayItem {
	readonly label: number;
	readonly prompt: string;
	/** 上游预先生成的答案。search 那份没有，填行 id —— 只影响 ④ 的问↔答形态 */
	readonly answer: string;
	/** 上游记录的真实生成耗时（秒）。没有就是 0 */
	readonly latencySeconds: number;
}

/**
 * ③ 放行、送到 ④ 面前的一对。**这就是 ④ 的标定集**，不是全集里随便两句话。
 *
 * `same` 是判据：两条属于同一个等价组就该复用。④ 要学会的正是「③ 觉得像、
 * 但其实不是同一件事」那一类 —— 而那一类只在这个分布里出现。
 */
export interface SurfacedPair {
	readonly queryPrompt: string;
	readonly queryAnswer: string;
	readonly candidatePrompt: string;
	readonly candidateAnswer: string;
	readonly same: boolean;
}

export interface ReplayRequest {
	readonly items: ReadonlyArray<ReplayItem>;
	readonly scopeKey: string;
	readonly floor: number;
	readonly topK: number;
	readonly embedQuestions: (texts: ReadonlyArray<string>) => Promise<Array<Array<number>>>;
	/** 不传就是 ④ 关。传了必须带 θq —— 这份数据上没有标定过的值，不许从别处借 */
	readonly rerank?: { readonly scorer: Reranker; readonly thetaQ: number; readonly target: RerankTarget };
	/** 收 ③ 放行的对子。只有标定那一趟需要，跑曲线时白占内存 */
	readonly collectPairs?: boolean;
}

export interface ReplayOutcome {
	readonly floor: number;
	readonly gate4: boolean;
	readonly queries: number;
	/** 到达时缓存里已有同组条目的查询数 —— 正命中的上限，也是漏命中的分母 */
	readonly reusable: number;
	readonly trueHits: number;
	readonly falseHits: number;
	readonly missedReuse: number;
	readonly correctRejects: number;
	readonly exitedAt: Record<string, number>;
	/** 正命中省下的生成耗时（秒） */
	readonly savedSeconds: number;
	readonly examples: ReadonlyArray<{
		readonly query: string;
		readonly reused: string;
		readonly queryLabel: number;
		readonly reusedLabel: number;
	}>;
	readonly pairs: ReadonlyArray<SurfacedPair>;
}

/**
 * 按顺序放一遍。**`items` 的顺序就是轨迹**，洗牌由调用方负责 —— 顺序是这个实验的
 * 自变量，藏在函数里就没人会想起要固定它。
 */
export async function replayTrace(req: ReplayRequest): Promise<ReplayOutcome> {
	const cache = createSemanticCache({
		recall: {
			scorer: { embedQuestions: req.embedQuestions },
			thresholds: { floor: req.floor },
			calibratedOn: `未在本数据上标定 —— floor=${req.floor} 是曲线上的一个点`,
		},
		rerank:
			req.rerank === undefined
				? undefined
				: {
						scorer: req.rerank.scorer,
						thresholds: { floor: req.rerank.thetaQ, target: req.rerank.target },
						calibratedOn: `θq=${req.rerank.thetaQ}，由调用方负责`,
					},
		store: createMemoryCacheStore(),
		/**
		 * 空检索。**这里曾经必须造一个占位依据**：SDK 的 `cacheable()` 要求
		 * `sourceIds` 非空（「没有依据的答案不写入」），不造的话每一条答案都写不进去、
		 * 缓存永远是空的而且一声不吭。⑤ 和 `sourceIds` 一起从 SDK 移除之后那个坑
		 * 没了，占位也跟着删掉 —— **删掉之后重放的数字一个没变**，这正说明当初那个
		 * 占位只是在满足一条形式要求，没有参与任何判定。
		 */
		retriever: { retrieve: async (): Promise<Array<Chunk>> => [] },
		// 单 scope：这份数据没有用户/租户维度，① 因此没有参与
		scope: () => ({ key: req.scopeKey, shared: true, org: "lab" }),
		recallLimit: req.topK,
		ttlMs: null,
	});

	/** entryId → 写它的那条查询。命中之后靠它判对错，也靠它取候选文本 */
	const byEntry = new Map<string, ReplayItem>();
	/** 缓存里现在有哪些组 —— oracle。没有驱逐，所以只增不减 */
	const labelsInCache = new Set<number>();

	let reusable = 0;
	let trueHits = 0;
	let falseHits = 0;
	let missedReuse = 0;
	let correctRejects = 0;
	let savedSeconds = 0;
	const exitedAt: Record<string, number> = {};
	const examples: Array<ReplayOutcome["examples"][number]> = [];
	const pairs: Array<SurfacedPair> = [];

	for (const it of req.items) {
		// **到达那一刻**的状态，必须在 resolve 之前读，否则就成了事后诸葛
		const hadPartner = labelsInCache.has(it.label);
		if (hadPartner) reusable += 1;

		const prompt: CachePrompt = {
			matchText: it.prompt,
			retrievalText: it.prompt,
			redacted: false,
			context: {},
		};
		const result = await cache.resolve(prompt, async () => ({ kind: "answer" as const, answer: it.answer }));

		if (result.outcome === "generated") {
			if (hadPartner) missedReuse += 1;
			else correctRejects += 1;
			const at = result.exitedAt === null ? "没被拦，只是没候选" : `第 ${result.exitedAt} 道闸`;
			exitedAt[at] = (exitedAt[at] ?? 0) + 1;
			if (result.entryId !== null) {
				byEntry.set(result.entryId, it);
				labelsInCache.add(it.label);
			}
			continue;
		}

		const candidate = result.entryId === null ? undefined : byEntry.get(result.entryId);
		const same = candidate !== undefined && candidate.label === it.label;
		if (req.collectPairs === true && candidate !== undefined) {
			pairs.push({
				queryPrompt: it.prompt,
				queryAnswer: it.answer,
				candidatePrompt: candidate.prompt,
				candidateAnswer: candidate.answer,
				same,
			});
		}
		// 对错只看组，不看答案文本 —— 同组两条的答案本来就是分别生成的，字面不一样
		if (same) {
			trueHits += 1;
			savedSeconds += it.latencySeconds;
		} else {
			falseHits += 1;
			if (examples.length < 20) {
				examples.push({
					query: it.prompt,
					reused: candidate === undefined ? "（未知条目）" : candidate.prompt,
					queryLabel: it.label,
					reusedLabel: candidate === undefined ? -1 : candidate.label,
				});
			}
		}
	}

	return {
		floor: req.floor,
		gate4: req.rerank !== undefined,
		queries: req.items.length,
		reusable,
		trueHits,
		falseHits,
		missedReuse,
		correctRejects,
		exitedAt,
		savedSeconds,
		examples,
		pairs,
	};
}
