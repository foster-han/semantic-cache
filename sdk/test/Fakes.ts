/**
 * 测试用的确定性假件。
 *
 * **向量一律用「给定余弦」构造，不用词袋哈希投影。** 哈希投影的分数是涌现出来的，
 * 想让某道闸落在阈值的哪一侧只能试；这里 `forCosine(0.96)` 就是 0.96，
 * 于是「中带」「刚好低于 floor」这类边界能被精确摆出来，测试也就不会因为
 * 换个模型或改个默认值而莫名其妙地翻。
 */
import { createMemoryCacheStore } from "../src/MemoryCacheStore.ts";
import { createSemanticCache } from "../src/SemanticCache.ts";
import type { GateSwitches, Refine, ScopeResolver } from "../src/types/Pipeline.ts";
import type { PairEncoder, Reranker, RerankTarget, RetrievalEncoder } from "../src/types/Encoders.ts";
import type { Chunk, Retriever, SourceVersionResolver } from "../src/types/Retrieval.ts";
import type { CacheStore, InspectableCacheStore } from "../src/types/CacheStore.ts";

/** 同一平面上的单位向量 —— 与 `[1,0,0]` 的余弦恰好是 `target`。 */
export function forCosine(target: number): Array<number> {
	const angle = Math.acos(target);
	return [Math.cos(angle), Math.sin(angle), 0];
}

export const BASE: ReadonlyArray<number> = [1, 0, 0];

export type VectorTable = Readonly<Record<string, ReadonlyArray<number>>>;

export interface Counts {
	questions: number;
	query: number;
	passage: number;
	retrieve: number;
	generate: number;
	refine: number;
	rerank: number;
}

export function freshCounts(): Counts {
	return { questions: 0, query: 0, passage: 0, retrieve: 0, generate: 0, refine: 0, rerank: 0 };
}

function lookupVector(table: VectorTable, text: string): Array<number> {
	const found = table[text];
	return found === undefined ? [...BASE] : [...found];
}

export function fakePair(table: VectorTable, counts: Counts): PairEncoder {
	return {
		async embedQuestions(texts) {
			counts.questions += 1;
			return texts.map(t => lookupVector(table, t));
		},
	};
}

export function fakeRetrieval(table: VectorTable, counts: Counts): RetrievalEncoder {
	return {
		async embedQuery(texts) {
			counts.query += 1;
			return texts.map(t => lookupVector(table, t));
		},
		async embedPassage(texts) {
			counts.passage += 1;
			return texts.map(t => lookupVector(table, t));
		},
	};
}

/** 按候选的 matchText 给分。没列出来的候选给 `fallback`。 */
export function fakeReranker(scores: Readonly<Record<string, number>>, counts: Counts, fallback = 1): Reranker {
	return {
		async score(_query, candidate) {
			counts.rerank += 1;
			return scores[candidate] ?? fallback;
		},
	};
}

export interface HarnessConfig {
	/** 问题文本 → 召回向量（PairEncoder 空间） */
	readonly pair?: VectorTable;
	/** 答案与片段文本 → passage 向量（RetrievalEncoder 空间） */
	readonly passage?: VectorTable;
	readonly retrieve?: (retrievalText: string, context: Readonly<Record<string, string>>) => Array<Chunk>;
	readonly rerank?: Readonly<Record<string, number>>;
	readonly rerankFloor?: number;
	/**
	 * ④ 拿旧问题还是旧答案当 candidate。默认 `"question"` —— 现有测试的
	 * `rerank` 表都是按问题文本建的键，默认换成 answer 会让它们全部查不到表。
	 */
	readonly rerankTarget?: RerankTarget;
	readonly recallFloor?: number;
	readonly support?: { readonly high: number; readonly low: number };
	readonly gates?: Partial<GateSwitches>;
	readonly refine?: Refine;
	readonly scope?: ScopeResolver;
	readonly sourceVersion?: SourceVersionResolver;
	readonly store?: CacheStore;
	readonly recallLimit?: number;
	readonly singleFlight?: boolean;
	readonly ttlMs?: number | null;
	readonly now?: () => number;
}

export const DEFAULT_CHUNK: Chunk = { id: "n1", text: "CHUNK n1" };

/**
 * 一套接好线的缓存。默认所有文本的向量都是 `BASE` —— 也就是「什么都相似、
 * 支撑度满分」，happy path 直接可用；要测某道闸就只覆盖它关心的那几个文本。
 */
export function harness(config: HarnessConfig = {}) {
	const counts = freshCounts();
	const store: InspectableCacheStore = (config.store as InspectableCacheStore) ?? createMemoryCacheStore({ now: config.now });
	const pair = fakePair(config.pair ?? {}, counts);
	const retrieval = fakeRetrieval(config.passage ?? {}, counts);
	const retrieveFn = config.retrieve ?? (() => [{ ...DEFAULT_CHUNK }]);
	const retriever: Retriever = {
		async retrieve(text, context) {
			counts.retrieve += 1;
			return retrieveFn(text, context);
		},
	};
	const cache = createSemanticCache({
		recall: { scorer: pair, thresholds: { floor: config.recallFloor ?? 0.5 }, calibratedOn: "测试用假件" },
		support: {
			scorer: retrieval,
			thresholds: { high: config.support?.high ?? 0.9, low: config.support?.low ?? 0.8 },
			calibratedOn: "测试用假件",
		},
		rerank:
			config.rerank === undefined
				? undefined
				: {
						scorer: fakeReranker(config.rerank, counts),
						thresholds: { floor: config.rerankFloor ?? 0.5, target: config.rerankTarget ?? "question" },
						calibratedOn: "测试用假件",
				  },
		store,
		retriever,
		scope: config.scope ?? (() => ({ key: "course:1", shared: true })),
		sourceVersion: config.sourceVersion ?? (() => "v1"),
		refine: config.refine,
		gates: config.gates,
		recallLimit: config.recallLimit ?? 5,
		singleFlight: config.singleFlight,
		ttlMs: config.ttlMs === undefined ? null : config.ttlMs,
		now: config.now,
	});
	return { cache, store, counts, retrieval, pair };
}

/** 最常用的生成：答案文本固定，依据固定。 */
export function answering(answer: string, sourceIds: ReadonlyArray<string> = ["n1"], counts?: Counts) {
	return async () => {
		if (counts) counts.generate += 1;
		return { kind: "answer" as const, answer, sourceIds: [...sourceIds] };
	};
}

/** 余弦是浮点运算，`forCosine(0.5)` 回来可能是 0.4999999999999999 —— 比到 1e-9 就够 */
export function closeTo(actual: number | null, expected: number, message?: string): void {
	assertOk(actual !== null && Math.abs(actual - expected) < 1e-9, `${message ?? "数值不符"}：期望 ≈${expected}，实际 ${String(actual)}`);
}

function assertOk(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

export function verdicts(trace: ReadonlyArray<{ gate: number; verdict: string }>): Record<number, string> {
	const out: Record<number, string> = {};
	for (const t of trace) out[t.gate] = t.verdict;
	return out;
}
