export { createSemanticCache, DEFAULT_GATES } from "./SemanticCache.ts";
export type { SemanticCache, SemanticCacheOptions } from "./SemanticCache.ts";
export { createMemoryCacheStore } from "./MemoryCacheStore.ts";
export { createPgVectorCacheStore } from "./PgVectorCacheStore.ts";
export type { PgVectorCacheStoreOptions } from "./PgVectorCacheStore.ts";
export { createRedisVectorSetCacheStore } from "./RedisVectorSetCacheStore.ts";
export type { RedisVectorSetCacheStoreOptions } from "./RedisVectorSetCacheStore.ts";
export { cosine, hashKey, normalizeKey } from "./VectorMath.ts";
export { composeScope } from "./Scope.ts";
export {
	assertDiscriminates,
	checkPairEncoder,
	checkReranker,
	checkRetrievalEncoder,
} from "./DiscriminationCheck.ts";
export type { DiscriminationReport, ProbePair } from "./DiscriminationCheck.ts";
export { generateProbes } from "./ProbeGenerator.ts";
export type {
	GeneratedProbe,
	ProbeGenerationOptions,
	ProbeGenerationReport,
	ProbeSource,
	ProbeTier,
	QuestionPhrasing,
} from "./types/ProbeGeneration.ts";
export { combinePolicies, createStructuralPolicy, DEFAULT_SEMANTIC_CALL_TYPES } from "./CachePolicyRules.ts";
export type { StructuralPolicyOptions } from "./CachePolicyRules.ts";
export type { CacheDisposition, CachePolicy } from "./types/CachePolicy.ts";
export { createMetrics } from "./Metrics.ts";
export type { LatencyStats, Metrics, MetricsOptions, MetricsRecording, MetricsSnapshot } from "./Metrics.ts";
export { compare, evaluate, sourceIdsOf } from "./Evaluation.ts";
export type { ComparisonReport, EvaluationHooks, EvaluationReport, Scenario, ScenarioOutcome } from "./Evaluation.ts";
export type { EncoderRole, PairEncoder, Reranker, RerankTarget, RetrievalEncoder } from "./types/Encoders.ts";
export type { Calibrated, RecallStage, RerankStage, SupportStage } from "./types/Calibration.ts";
export type { CacheEntry, CacheStore, Candidate, InspectableCacheStore } from "./types/CacheStore.ts";
export type { EvictionConfig, EvictionPolicy } from "./types/Eviction.ts";
// 三个后端共用的淘汰序参数。导出是为了让一致性测试能断言「三处封在同一个值上」
export { LFU_COUNT_CAP, lfuCount } from "./EvictionOrder.ts";
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
