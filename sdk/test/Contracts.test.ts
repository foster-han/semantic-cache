/**
 * Construction-time guards.
 *
 * Every assertion here is the inverse of a silent failure: an out-of-range threshold raises nothing
 * and just makes that gate always pass or always stop; `recallLimit = 1` raises nothing and just
 * leaves gate ④ with nothing to rank; an empty `calibratedOn` raises nothing and just means nobody
 * knows six months later what data these numbers came from. So all of them must throw at
 * construction.
 */

import { createMemoryCacheStore } from "../src/MemoryCacheStore.ts";
import { createSemanticCache } from "../src/SemanticCache.ts";
import type { RecallStage, RerankStage } from "../src/types/Calibration.ts";
import type { RerankTarget } from "../src/types/Encoders.ts";
import { assertFiniteVector, cosine, hashKey, normalizeKey } from "../src/VectorMath.ts";
import { harness } from "./Fakes.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";

test("recallLimit must be an integer greater than 1 — a non-integer only explodes on a real database and runs fine locally", () => {
	assert.throws(() => harness({ recallLimit: 1 }), /recallLimit must be an integer greater than 1/u);
	// 2.5 used to construct successfully: the memory backend runs slice(2.5) happily, while pgvector's
	// LIMIT and Redis's VSIM COUNT raise "not an integer" at run time — a configuration error that
	// only appears against a real database.
	assert.throws(() => harness({ recallLimit: 2.5 }), /recallLimit must be an integer greater than 1/u);
	assert.throws(() => harness({ recallLimit: Number.NaN }), /recallLimit must be an integer greater than 1/u);
	assert.doesNotThrow(() => harness({ recallLimit: 2 }));
});

test("an out-of-range cosine threshold throws on the spot, rather than becoming always-pass or always-stop at run time", () => {
	assert.throws(() => harness({ recallFloor: 1.5 }), /recall\.thresholds\.floor/u);
	assert.throws(() => harness({ recallFloor: Number.NaN }), /recall\.thresholds\.floor/u);
});

test("gate ④'s floor is only checked for finiteness, not [-1,1] — a reranker's scale is not cosine", () => {
	assert.throws(() => harness({ rerank: {}, rerankFloor: Number.POSITIVE_INFINITY }), /rerank\.thresholds\.floor/u);
	// A reranker may return a logit, so 5.2 is a legitimate floor; imposing [-1,1] would be one more
	// instance of mixing scales.
	assert.doesNotThrow(() => harness({ rerank: {}, rerankFloor: 5.2 }));
});

test("gate ④'s target must be question or answer — a misspelling falls silently onto the other scale", () => {
	/**
	 * It is a union type, but a JavaScript caller can get around that. A misspelled target treated as
	 * "anything but answer means question" applies a θq calibrated for question-to-answer to
	 * question-to-question scores — on one and the same bge-reranker-base that is the difference
	 * between 0.3494 and 0.1228, with nothing raised.
	 */
	const bad = "Answer" as unknown as RerankTarget;
	assert.throws(() => harness({ rerank: {}, rerankTarget: bad }), /rerank\.thresholds\.target/u);
	assert.doesNotThrow(() => harness({ rerank: {}, rerankTarget: "answer" }));
	assert.doesNotThrow(() => harness({ rerank: {}, rerankTarget: "question" }));
});

test("calibratedOn is required and must not be empty — a threshold means nothing outside its calibration context", () => {
	assert.doesNotThrow(() => buildWith({}), "with calibratedOn on both stages it should pass");
	assert.throws(() => buildWith({ recall: "" }), /recall\.calibratedOn must not be an empty string/u);
	assert.throws(() => buildWith({ rerank: "" }), /rerank\.calibratedOn must not be an empty string/u);
});

/** Only the test above needs to bypass the harness's default calibratedOn, so both stages are built inline here. */
function buildWith(blank: { recall?: string; rerank?: string }): void {
	const recall: RecallStage = {
		scorer: {
			embedQuestions(texts) {
				return Promise.resolve(texts.map(() => [1, 0, 0]));
			},
		},
		thresholds: { floor: 0.5 },
		calibratedOn: blank.recall ?? "this calibration context",
	};
	const rerank: RerankStage = {
		scorer: {
			score() {
				return Promise.resolve(1);
			},
		},
		thresholds: { floor: 0.5, target: "question" },
		calibratedOn: blank.rerank ?? "this calibration context",
	};
	createSemanticCache({
		recall,
		rerank,
		store: createMemoryCacheStore(),
		retriever: {
			retrieve() {
				return Promise.resolve([]);
			},
		},
		scope: () => ({ key: "course:1", shared: true, org: "org:1" }),
	});
}

test("cosine's dimension check — mixing two model roles' outputs must explode rather than invent a meaningless number", () => {
	assert.throws(() => cosine([1, 0], [1, 0, 0]), /Vector dimensions differ/u);
	assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1);
	assert.equal(cosine([1, 0, 0], [0, 1, 0]), 0);
	// A zero vector has no direction, so 0 by convention — pgvector's NaN is folded to the same value.
	assert.equal(cosine([0, 0, 0], [1, 0, 0]), 0);
});

test("all three backends throw on a non-finite component — one broken encoder must not become a false hit on the memory backend", async () => {
	assert.throws(() => assertFiniteVector("matchVector", [1, Number.NaN, 0]), /matchVector dimension 1 is NaN/u);
	assert.throws(() => assertFiniteVector("query vector", [Number.POSITIVE_INFINITY]), /not a finite number/u);
	assert.doesNotThrow(() => assertFiniteVector("empty vector", []));

	/**
	 * The memory backend used to store the NaN as-is: `cosine` then returns NaN, and gate ③'s
	 * `similarity < floor` is always false for NaN — the recall floor effectively does not exist, and
	 * a completely unrelated question can be reused. The same input is a hard error on pgvector and
	 * is silently written as 0 on Redis: three symptoms.
	 */
	const store = createMemoryCacheStore();
	const entry = {
		id: "e1",
		scope: "s",
		matchText: "q",
		matchHash: "h",
		matchVector: [Number.NaN, 0, 0],
		kind: "answer" as const,
		answer: "a",
		plan: {},
		createdAt: 1,
		expiresAt: null,
	};
	await assert.rejects(() => store.put(entry), /matchVector dimension 0 is NaN/u);
	await assert.rejects(() => store.searchNearest("s", [Number.NaN, 0, 0], 5), /query vector dimension 0/u);
});

test("normalizeKey collapses whitespace, folds case and drops trailing punctuation; hashKey is stable", () => {
	assert.equal(normalizeKey("  什么是过拟合？ "), "什么是过拟合");
	assert.equal(normalizeKey("What Is Overfitting?"), "what is overfitting");
	assert.equal(normalizeKey("同一句话！！"), "同一句话");
	assert.equal(normalizeKey("句中。的标点不动"), "句中。的标点不动");
	// Runs of whitespace collapse to one rather than being deleted.
	assert.equal(normalizeKey("what   is\tover fitting"), "what is over fitting");
	assert.equal(hashKey("abc"), hashKey("abc"));
	assert.notEqual(hashKey("abd"), hashKey("abc"));
});

test("whitespace is collapsed rather than deleted: two different English questions must not fold onto one key", () => {
	// Deleting whitespace outright would collide these two on "whatisoverfitting", which costs ②
	// its zero-false-hit guarantee — and ③'s collision recheck runs the same normalizeKey, so it
	// cannot catch a merge of this kind.
	assert.notEqual(normalizeKey("what is over fitting"), normalizeKey("what is overfitting"));
	assert.notEqual(hashKey(normalizeKey("a nice cache")), hashKey(normalizeKey("anice cache")));
});
