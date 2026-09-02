/**
 * Deterministic fakes for the tests.
 *
 * **Vectors are always built from a given cosine rather than from a bag-of-words hash
 * projection.** Scores out of a hash projection are emergent, so putting a gate on one side of
 * its threshold takes trial and error; here `forCosine(0.96)` really is 0.96, which lets
 * boundaries like the mid band or just-below-the-floor be placed exactly — and keeps tests from
 * flipping for no visible reason when a model or a default changes.
 */
import { createMemoryCacheStore } from "../src/MemoryCacheStore.ts";
import { createSemanticCache } from "../src/SemanticCache.ts";
import type { CachePolicy } from "../src/types/CachePolicy.ts";
import type { CacheStore, InspectableCacheStore } from "../src/types/CacheStore.ts";
import type { PairEncoder, Reranker, RerankTarget } from "../src/types/Encoders.ts";
import type { ScopeResolver } from "../src/types/Pipeline.ts";
import type { Chunk, Retriever } from "../src/types/Retrieval.ts";

/** A unit vector in the same plane, whose cosine with `[1,0,0]` is exactly `target`. */
export function forCosine(target: number): Array<number> {
	const angle = Math.acos(target);
	return [Math.cos(angle), Math.sin(angle), 0];
}

export const BASE: ReadonlyArray<number> = [1, 0, 0];

export type VectorTable = Readonly<Record<string, ReadonlyArray<number>>>;

export interface Counts {
	questions: number;
	retrieve: number;
	generate: number;
	refine: number;
	rerank: number;
}

export function freshCounts(): Counts {
	return { questions: 0, retrieve: 0, generate: 0, refine: 0, rerank: 0 };
}

function lookupVector(table: VectorTable, text: string): Array<number> {
	const found = table[text];
	return found === undefined ? [...BASE] : [...found];
}

export function fakePair(table: VectorTable, counts: Counts): PairEncoder {
	return {
		embedQuestions(texts) {
			counts.questions += 1;
			return Promise.resolve(texts.map(t => lookupVector(table, t)));
		},
	};
}

/** Scores by the candidate's matchText. Candidates not listed get `fallback`. */
export function fakeReranker(scores: Readonly<Record<string, number>>, counts: Counts, fallback = 1): Reranker {
	return {
		score(_query, candidate) {
			counts.rerank += 1;
			return Promise.resolve(scores[candidate] ?? fallback);
		},
	};
}

export interface HarnessConfig {
	/** Question text to recall vector, in PairEncoder space. */
	readonly pair?: VectorTable;
	readonly retrieve?: (retrievalText: string, context: Readonly<Record<string, string>>) => Array<Chunk>;
	readonly rerank?: Readonly<Record<string, number>>;
	readonly rerankFloor?: number;
	/**
	 * Whether ④ takes the old question or the old answer as its candidate. `"question"` by
	 * default: the existing tests' `rerank` tables are all keyed on question text, and defaulting
	 * to the answer would leave every one of them missing its entry.
	 */
	readonly rerankTarget?: RerankTarget;
	readonly recallFloor?: number;
	readonly scope?: ScopeResolver;
	readonly store?: CacheStore;
	readonly recallLimit?: number;
	readonly singleFlight?: boolean;
	readonly ttlMs?: number | null;
	readonly now?: () => number;
	readonly policy?: CachePolicy;
	readonly shadow?: boolean;
}

export const DEFAULT_CHUNK: Chunk = { id: "n1", text: "CHUNK n1" };

/**
 * A fully wired cache. By default every text's vector is `BASE` — everything is similar and
 * support is perfect — so the happy path works out of the box; to exercise one gate, override
 * only the texts it cares about.
 */
export function harness(config: HarnessConfig = {}) {
	const counts = freshCounts();
	const store: InspectableCacheStore =
		(config.store as InspectableCacheStore) ?? createMemoryCacheStore({ now: config.now });
	const pair = fakePair(config.pair ?? {}, counts);
	const retrieveFn = config.retrieve ?? (() => [{ ...DEFAULT_CHUNK }]);
	const retriever: Retriever = {
		retrieve(text, context) {
			counts.retrieve += 1;
			return Promise.resolve(retrieveFn(text, context));
		},
	};
	const cache = createSemanticCache({
		recall: { scorer: pair, thresholds: { floor: config.recallFloor ?? 0.5 }, calibratedOn: "test fakes" },
		rerank:
			config.rerank === undefined
				? undefined
				: {
						scorer: fakeReranker(config.rerank, counts),
						thresholds: { floor: config.rerankFloor ?? 0.5, target: config.rerankTarget ?? "question" },
						calibratedOn: "test fake",
					},
		store,
		retriever,
		scope: config.scope ?? (() => ({ key: "course:1", shared: true, org: "org:1" })),
		recallLimit: config.recallLimit ?? 5,
		singleFlight: config.singleFlight,
		ttlMs: config.ttlMs === undefined ? null : config.ttlMs,
		policy: config.policy,
		shadow: config.shadow,
		now: config.now,
	});
	return { cache, store, counts, pair };
}

/** The most common generator: fixed answer text. */
export function answering(answer: string, counts?: Counts) {
	return () => {
		if (counts) {
			counts.generate += 1;
		}
		return Promise.resolve({ kind: "answer" as const, answer });
	};
}

/** Cosine is floating point, so `forCosine(0.5)` may come back as 0.4999999999999999 — comparing to 1e-9 is enough. */
export function closeTo(actual: number | null, expected: number, message?: string): void {
	assertOk(
		actual !== null && Math.abs(actual - expected) < 1e-9,
		`${message ?? "value mismatch"}: expected ~${expected}, got ${String(actual)}`,
	);
}

function assertOk(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(message);
	}
}

export function verdicts(trace: ReadonlyArray<{ gate: number; verdict: string }>): Record<number, string> {
	const out: Record<number, string> = {};
	for (const t of trace) {
		out[t.gate] = t.verdict;
	}
	return out;
}
