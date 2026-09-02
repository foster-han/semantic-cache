export type { StructuralPolicyOptions } from "./CachePolicyRules.ts";
export { combinePolicies, createStructuralPolicy, DEFAULT_SEMANTIC_CALL_TYPES } from "./CachePolicyRules.ts";
export type {
	DiscriminationReport,
	ProbePair,
	ThresholdSuggestion,
	ThresholdSuggestionOptions,
} from "./DiscriminationCheck.ts";
export {
	assertDiscriminates,
	checkPairEncoder,
	checkReranker,
	suggestThreshold,
} from "./DiscriminationCheck.ts";
export type { ComparisonReport, EvaluationHooks, EvaluationReport, Scenario, ScenarioOutcome } from "./Evaluation.ts";
export { compare, evaluate } from "./Evaluation.ts";
// Eviction-ordering parameters shared by the three backends. Exported so conformance tests can
// assert that all three cap at the same value.
export { LFU_COUNT_CAP, lfuCount } from "./EvictionOrder.ts";
export { createMemoryCacheStore } from "./MemoryCacheStore.ts";
export type { LatencyStats, Metrics, MetricsOptions, MetricsRecording, MetricsSnapshot } from "./Metrics.ts";
export { createMetrics } from "./Metrics.ts";
export type { PgVectorCacheStoreOptions } from "./PgVectorCacheStore.ts";
export { createPgVectorCacheStore } from "./PgVectorCacheStore.ts";
export { generateProbes } from "./ProbeGenerator.ts";
export type { RedisVectorSetCacheStoreOptions } from "./RedisVectorSetCacheStore.ts";
export { createRedisVectorSetCacheStore } from "./RedisVectorSetCacheStore.ts";
export { composeScope } from "./Scope.ts";
export type { SemanticCache, SemanticCacheOptions } from "./SemanticCache.ts";
export { createSemanticCache } from "./SemanticCache.ts";
export type { CacheDisposition, CachePolicy } from "./types/CachePolicy.ts";
export type { CacheEntry, CacheStore, Candidate, InspectableCacheStore } from "./types/CacheStore.ts";
export type { Calibrated, RecallStage, RerankStage } from "./types/Calibration.ts";
export type { EncoderRole, PairEncoder, Reranker, RerankTarget } from "./types/Encoders.ts";
export type { EvictionConfig, EvictionPolicy } from "./types/Eviction.ts";
export type {
	CachedPayload,
	CachePrompt,
	CacheResult,
	GateId,
	GateTrace,
	GateVerdict,
	Generate,
	LookupOutcome,
	LookupResult,
	Outcome,
	ScopeDecision,
	ScopeResolver,
	WriteItem,
	WriteOptions,
	WriteTicket,
} from "./types/Pipeline.ts";
export type {
	GeneratedProbe,
	ProbeGenerationOptions,
	ProbeGenerationReport,
	ProbeSource,
	ProbeTier,
	QuestionPhrasing,
} from "./types/ProbeGeneration.ts";
export type { RedisExecutor } from "./types/RedisExecutor.ts";
export type { Chunk, Retriever } from "./types/Retrieval.ts";
export type { SqlExecutor, SqlRows } from "./types/SqlExecutor.ts";
// assertFiniteVector is exported for anyone implementing CacheStore themselves: a non-finite
// component must throw, because silently coercing to 0 or storing it as-is makes gate ③'s recall
// floor effectively nonexistent (all three built-in backends go through it).
export { assertFiniteVector, cosine, hashKey, normalizeKey } from "./VectorMath.ts";
