export { createSemanticCache, DEFAULT_GATES } from "./SemanticCache.ts";
export type { SemanticCache, SemanticCacheOptions } from "./SemanticCache.ts";
export { createMemoryCacheStore } from "./MemoryCacheStore.ts";
export { createPgVectorCacheStore } from "./PgVectorCacheStore.ts";
export type { PgVectorCacheStoreOptions } from "./PgVectorCacheStore.ts";
export { createRedisVectorSetCacheStore } from "./RedisVectorSetCacheStore.ts";
export type { RedisVectorSetCacheStoreOptions } from "./RedisVectorSetCacheStore.ts";
export { cosine, hashKey, normalizeKey } from "./VectorMath.ts";
export {
	assertDiscriminates,
	checkPairEncoder,
	checkReranker,
	checkRetrievalEncoder,
} from "./DiscriminationCheck.ts";
export type { DiscriminationReport, ProbePair } from "./DiscriminationCheck.ts";
export { createMetrics } from "./Metrics.ts";
export type { LatencyStats, Metrics, MetricsOptions, MetricsRecording, MetricsSnapshot } from "./Metrics.ts";
export { compare, evaluate, sourceIdsOf } from "./Evaluation.ts";
export type { ComparisonReport, EvaluationHooks, EvaluationReport, Scenario, ScenarioOutcome } from "./Evaluation.ts";
export type { EncoderRole, PairEncoder, Reranker, RerankTarget, RetrievalEncoder } from "./types/Encoders.ts";
export type { Calibrated, RecallStage, RerankStage, SupportStage } from "./types/Calibration.ts";
export type { CacheEntry, CacheStore, Candidate, InspectableCacheStore } from "./types/CacheStore.ts";
export type { EvictionConfig, EvictionPolicy } from "./types/Eviction.ts";
export type { RedisExecutor } from "./types/RedisExecutor.ts";
export type { SqlExecutor, SqlRows } from "./types/SqlExecutor.ts";
export type { Chunk, Retriever, SourceVersionResolver } from "./types/Retrieval.ts";
export type {
	CachedPayload,
	CachePrompt,
	CacheResult,
	GateId,
	GateSwitches,
	GateTrace,
	GateVerdict,
	Generate,
	GeneratedAnswer,
	LookupOutcome,
	LookupResult,
	Outcome,
	Refine,
	ScopeResolver,
	WriteItem,
	WriteOptions,
	WriteTicket,
} from "./types/Pipeline.ts";
