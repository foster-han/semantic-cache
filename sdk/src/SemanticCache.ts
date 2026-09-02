import { composeScope } from "./Scope.ts";
import type { CachePolicy } from "./types/CachePolicy.ts";
import type { CacheEntry, CacheStore } from "./types/CacheStore.ts";
import type { RecallStage, RerankStage } from "./types/Calibration.ts";
import type {
	CachedPayload,
	CachePrompt,
	CacheResult,
	GateId,
	GateTrace,
	Generate,
	LookupOutcome,
	LookupResult,
	ScopeResolver,
	WriteItem,
	WriteOptions,
	WriteTicket,
} from "./types/Pipeline.ts";
import type { Retriever } from "./types/Retrieval.ts";
import { hashKey, normalizeKey } from "./VectorMath.ts";

/**
 * Thresholds have **no defaults**; the caller must supply them together with the scorer.
 *
 * Providing default thresholds would encourage skipping calibration — and a threshold never
 * calibrated on your own data is, however reasonable the number looks, a product of somebody else's
 * corpus.
 */
export interface SemanticCacheOptions {
	/** Gate ③ recall: the scorer and the cosine floor **calibrated for it**. */
	readonly recall: RecallStage;
	/**
	 * Gate ④ rerank: the scorer and the threshold calibrated for it.
	 * **Omitting it means the gate does not exist**; it does not degrade into applying that threshold
	 * to the recall cosine.
	 */
	readonly rerank?: RerankStage | undefined;
	readonly store: CacheStore;
	readonly retriever: Retriever;
	readonly scope: ScopeResolver;
	/** How many candidates gate ③ recalls. **Must be greater than 1**, or gate ④ has nothing to rank. */
	readonly recallLimit?: number | undefined;
	readonly ttlMs?: number | null | undefined;
	readonly newId?: (() => string) | undefined;
	/**
	 * In-process single-flight: concurrent identical questions generate once. On by default.
	 * Turn it off when each request's `generate` or `writeOptions` must take effect individually.
	 */
	readonly singleFlight?: boolean | undefined;
	/**
	 * Which prompts should never enter the cache, decided ahead of every gate. Omitted, everything is
	 * cacheable.
	 *
	 * On a `bypass` verdict `lookup` runs no gate at all and **issues no write ticket** — write such
	 * a question once and the next one is a false hit.
	 */
	readonly policy?: CachePolicy | undefined;
	/**
	 * Shadow mode. Defaults to `false`.
	 *
	 * With it on: every gate still runs and new entries are still written (otherwise the cache never
	 * warms up), but nothing is **ever reused**, and the read path is **strictly read-only** — no
	 * eviction, no touch. The real verdict goes into `LookupResult.wouldHave` and
	 * `CacheResult.wouldReuse`, and with `Metrics`'s `shadow.wouldReuseRate` it answers "how much
	 * would this hit if it were really on".
	 *
	 * Not touching is the point: an evaluation must not change the thing it evaluates. `touch()`
	 * feeds `lru`/`lfu` eviction, so counting shadow reads as real uses would let the evaluation
	 * decide which entries survive — the ordering under test, rewritten by the test.
	 */
	readonly shadow?: boolean | undefined;
	readonly now?: (() => number) | undefined;
}

type RedactionGuard = (kind: "answer" | "plan") => void;

/**
 * Whether redaction plus a shared scope is dangerous depends on **what is cached**.
 *
 * Answer entries are dangerous: they contain entity-specific content, redaction collapses different
 * subjects onto one key, and reuse across subjects attributes one person's answer to another.
 * Plan entries are not: entities are only parameters, filled from the current request at execution
 * time and authorized there and then — the collapse is exactly what is wanted, one template serving
 * everyone.
 */
function makeRedactionGuard(prompt: CachePrompt, scope: string, shared: boolean): RedactionGuard {
	return kind => {
		if (kind !== "answer" || prompt.redacted !== true || !shared) {
			return;
		}
		throw new Error(
			`A redacted request hit or wrote an answer entry in shared scope "${scope}". Redaction collapses different ` +
				"subjects onto one cache key, and an answer contains entity-specific content, so reuse across subjects " +
				"necessarily attributes it to the wrong person. The options are: " +
				"(a) have ScopeResolver return { key, shared: false } for such requests, isolating per subject; " +
				'(b) cache kind:"plan" instead (entities as parameters, filled and authorized at execution time) — tool-shaped questions belong here; ' +
				"(c) do not cache.",
		);
	};
}

function payloadOf(entry: CacheEntry): CachedPayload {
	return entry.kind === "plan"
		? { kind: "plan", plan: entry.plan }
		: { kind: "answer", answer: entry.answer };
}

/** A cosine-scale threshold. A value outside [-1, 1] raises no error; it just makes that gate always pass or always stop. */
function assertCosineThreshold(name: string, value: number): void {
	if (!Number.isFinite(value) || value < -1 || value > 1) {
		throw new Error(
			`${name} is a cosine-scale threshold and must fall in [-1, 1], received ${String(value)}. ` +
				"An out-of-range threshold raises no error; it just makes that gate always pass or always stop — a silent failure.",
		);
	}
}

function assertCalibratedOn(stage: string, value: string): void {
	if (value.trim() === "") {
		throw new Error(
			`${stage}.calibratedOn must not be an empty string. A threshold means nothing outside its calibration context; ` +
				"one sentence recording what data and what operator it was calibrated on is far cheaper than archaeology later.",
		);
	}
}

/**
 * Layered semantic cache.
 *
 *   ① scope gating   — the isolation boundary, decided by the caller's ScopeResolver
 *   ② exact match    — normalized hash
 *   ③ vector recall  — top-k, where k must be > 1
 *   ④ rerank         — the main precision lever
 *
 * Four gates, and ⑤ in a `GateTrace` is the write step rather than a fifth gate. Two earlier gates
 * were removed: ⑥ answer validation (see `verify`) and ⑤ source-version comparison, which needed
 * every entry to record the documents it cited. Entries now record only the space they belong to,
 * so revised material is invalidated with `clear()` on that space instead of at read time.
 *
 * There is no retrieval on the read path — `Retriever` is called once, only when generation is
 * certain.
 */
/**
 * The "ticket" for a bypass: calling it always throws.
 *
 * Returning a usable ticket and trusting the caller not to write would be no guard at all — this
 * API's approach throughout is that an incorrect use gets nothing, rather than getting something
 * that fails later.
 */
/**
 * A reason must not be the empty string. **`""` is not `null`** — without this check, a policy
 * returning `{ noCache: "" }` bypasses silently with no explanation, while the whole point of this
 * layer is that "why was this not cached" has an answer. The same rule `assertCalibratedOn` applies
 * to `calibratedOn`.
 */
function assertReason(field: string, value: string | undefined): string | null {
	if (value === undefined) {
		return null;
	}
	if (value.trim() === "") {
		throw new Error(
			`CachePolicy returned an empty string for ${field}. To bypass, give a reason (it goes into the trace and the dashboard); to not bypass, omit the field.`,
		);
	}
	return value;
}

/**
 * The normalized cache key. **A blank `matchText` is stopped here.**
 *
 * `""` and `"   "` normalize to the same empty string, so they are ② exact hits for each other:
 * one upstream occurrence of "the prompt assembled to nothing" and every later empty prompt gets
 * that answer, by the most trusted path there is — no gates, no similarity, and a trace that looks
 * entirely normal.
 *
 * An empty prompt is always an upstream bug rather than an input to absorb, so this throws instead
 * of treating it as a miss: treated as a miss it would be written as usual, leaving the source of
 * that false hit sitting in the store.
 */
function matchKeyOf(prompt: CachePrompt): { normalized: string; matchHash: string } {
	if (typeof prompt.matchText !== "string" || prompt.matchText.trim() === "") {
		throw new Error(
			`matchText is empty (received ${JSON.stringify(prompt.matchText)}). It normalizes to the empty string, ` +
				"and empty strings are ② exact hits for one another — one empty prompt written upstream and every later " +
				"empty prompt hits it exactly. A cache key must come from real question text.",
		);
	}
	const normalized = normalizeKey(prompt.matchText);
	return { normalized, matchHash: hashKey(normalized) };
}

function bypassTicket(reason: string): () => Promise<WriteTicket> {
	return function refuse(): Promise<WriteTicket> {
		return Promise.reject(
			new Error(
				`CachePolicy judged this prompt uncacheable (${reason}), so no write ticket is available. To write, let the policy allow it first.`,
			),
		);
	};
}

export function createSemanticCache(options: SemanticCacheOptions) {
	const recall = options.recall;
	const rerank = options.rerank;
	const recallLimit = options.recallLimit ?? 5;
	const ttlMs = options.ttlMs === undefined ? 60 * 60 * 1000 : options.ttlMs;
	const now = options.now ?? (() => Date.now());
	const singleFlight = options.singleFlight ?? true;
	/** Shadow mode: the read path is strictly read-only — an evaluation must not change what it evaluates. */
	const shadow = options.shadow ?? false;
	let counter = 0;
	/**
	 * "Timestamp plus in-process counter" collides across a multi-instance deployment: two processes
	 * both write counter=1 within the same millisecond and produce the same id. A random suffix
	 * generated once per instance is enough to fix it.
	 *
	 * Not `crypto.randomUUID()`: v4 is purely random, and as a primary key it destroys btree
	 * insertion locality — while a cache is write-heavy by nature. The ids here stay time-ordered and
	 * insert sequentially. Cryptographic randomness is not needed either: an id is not a secret, it
	 * only has to avoid collisions.
	 */
	const instance = `${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 6)}`;
	function nextId(): string {
		counter += 1;
		return `${now().toString(36)}-${counter.toString(36)}-${instance}`;
	}
	const newId = options.newId ?? nextId;

	if (!Number.isInteger(recallLimit) || recallLimit < 2) {
		throw new Error(
			`recallLimit must be an integer greater than 1, received ${String(options.recallLimit)}. ` +
				"Recalling only 1 leaves no candidate set: gate ④ has nothing to rank (now, or whenever it is added), and " +
				'any A/B about "is reranking worth it" is meaningless — you would be comparing two binary decisions. ' +
				// A non-integer does not fail here; it fails in the backend, and differently in each of the three.
				"A non-integer is another silent divergence: the memory backend runs slice(2.5) happily, while pgvector's " +
				'LIMIT $4 and the Redis VSIM COUNT raise "not an integer" at run time — it works locally and explodes against a real database.',
		);
	}

	/**
	 * Threshold validity is checked at construction.
	 *
	 * **Only cosine-scale thresholds can be range-checked.** Gate ④ uses the reranker's own score
	 * scale (possibly a logit, possibly a post-sigmoid probability), and imposing [-1, 1] on it would
	 * be one more instance of mixing scales — precisely what this type design keeps guarding against.
	 * So the rerank threshold is only checked for being a finite number.
	 */
	assertCosineThreshold("recall.thresholds.floor", recall.thresholds.floor);
	if (rerank && !Number.isFinite(rerank.thresholds.floor)) {
		throw new Error(
			`rerank.thresholds.floor must be a finite number, received ${String(rerank.thresholds.floor)}.`,
		);
	}
	/**
	 * `target` decides what gate ④ uses as the candidate, and therefore the score scale. It is a
	 * union type, but a JavaScript caller can get around that — and a misspelled target falls
	 * silently into the "anything but answer means question" branch, applying a θq calibrated for
	 * question-to-answer to question-to-question scores. So it is checked at run time as well.
	 */
	if (rerank && rerank.thresholds.target !== "question" && rerank.thresholds.target !== "answer") {
		throw new Error(
			`rerank.thresholds.target must be "question" or "answer", received ${JSON.stringify(rerank.thresholds.target)}. ` +
				"It decides whether gate ④ hands the reranker the old question or the old answer — different scales, and θq does not transfer between them.",
		);
	}
	assertCalibratedOn("recall", recall.calibratedOn);
	if (rerank) {
		assertCalibratedOn("rerank", rerank.calibratedOn);
	}

	/**
	 * Resolve the isolation boundary. **All three paths (lookup / prepareTicket / writeMany) must go
	 * through one implementation** — there used to be three copies, and changing the composition in
	 * any one of them made the scope written differ from the scope read, showing up as "it was
	 * definitely written and can never be read back" with no error at all.
	 */
	async function resolveScope(prompt: CachePrompt): Promise<{ scope: string; shared: boolean }> {
		const decision = await options.scope(prompt);
		return { scope: composeScope(decision.org, decision.key), shared: decision.shared };
	}

	/* ------------------------------------------------------------------ *
	 * Matching — the read-only path. Runs ①–④; generates nothing, writes nothing, evicts nothing.
	 * ------------------------------------------------------------------ */

	// This is the gate chain itself: policy, then ①②③④, each with its own exit and its own trace
	// entry. The complexity is the chain's length, not tangled control flow — extracting each gate
	// into a helper would scatter the shared `trace`, `ticket` and `reasons` across five closures
	// and make the order they run in something you have to reconstruct by reading call sites.
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one gate per branch, in order
	async function lookup(prompt: CachePrompt): Promise<LookupResult> {
		const trace: Array<GateTrace> = [];
		/** The TTL the policy set for this entry; `undefined` means the policy had no opinion and the global default applies. */
		let policyTtlMs: number | null | undefined;
		let noCacheReason: string | null = null;
		let noStoreReason: string | null = null;

		/**
		 * **`CachePolicy` comes before every gate.** It answers not "is this cache entry still valid"
		 * but "should this question enter the cache at all" — and leaving the latter to a gate means
		 * paying the whole recall-plus-retrieval-plus-support cost before discovering it should not be
		 * used, while still failing to stop the write.
		 *
		 * The two switches are orthogonal, so **the decision is made here and returned after the
		 * ticket is assembled**: `noCache` used on its own ("answer again") must still be able to
		 * write back, and an early return would discard the ticket along with everything else.
		 */
		if (options.policy) {
			const disposition = await options.policy(prompt);
			noCacheReason = assertReason("noCache", disposition.noCache);
			noStoreReason = assertReason("noStore", disposition.noStore);
			policyTtlMs = disposition.ttlMs;
		}

		const { scope, shared } = await resolveScope(prompt);
		const guard = makeRedactionGuard(prompt, scope, shared);
		const { normalized, matchHash } = matchKeyOf(prompt);

		/**
		 * The recall vector is only needed on the write path. Computing it eagerly on a ② exact hit
		 * would make the microsecond-scale layer pay for a model call every time — so it is lazy and
		 * memoized.
		 */
		let ticket: WriteTicket | null = null;
		async function prepareWrite(): Promise<WriteTicket> {
			ticket ??= {
				scope,
				shared,
				matchHash,
				matchVector: (await recall.scorer.embedQuestions([prompt.matchText]))[0],
				ttlMs: policyTtlMs,
			};
			return ticket;
		}

		/** Under `noStore` the ticket must be refused — not "skip the write this time" but writing being impossible. */
		const issueTicket = noStoreReason === null ? prepareWrite : bypassTicket(noStoreReason);

		function miss(exitedAt: GateId): LookupResult {
			return {
				outcome: "miss",
				payload: null,
				entryId: null,
				scope,
				exitedAt,
				trace,
				wouldHave: null,
				noCacheReason,
				noStoreReason,
				prepareWrite: issueTicket,
			};
		}

		// `noCache`: not one gate runs. The trace stays empty — recording it as some gate's verdict would be a lie.
		if (noCacheReason !== null) {
			return {
				outcome: "bypass",
				payload: null,
				entryId: null,
				scope,
				exitedAt: null,
				trace,
				wouldHave: null,
				noCacheReason,
				noStoreReason,
				prepareWrite: issueTicket,
			};
		}

		trace.push({
			gate: 1,
			name: "scope gating",
			verdict: "pass",
			detail: `scope = ${scope}${shared ? " (shared)" : " (isolated)"}${prompt.redacted ? " · redacted" : ""}`,
		});

		/* ② Exact match */
		const candidate = await options.store.getByHash(scope, matchHash);
		// A hash hit is not enough: matchHash is not a cryptographic hash, and one collision returns a
		// completely unrelated answer — while the entire value of this layer is zero false-hit risk. So
		// the original text is compared again here, without relying on the store implementation.
		const exact = candidate && normalizeKey(candidate.matchText) === normalized ? candidate : null;
		if (exact) {
			trace.push({ gate: 2, name: "exact match", verdict: "hit", detail: `hit entry ${exact.id}` });
			return verify(exact, prompt, trace, guard, issueTicket, true, { noCacheReason, noStoreReason });
		}
		trace.push({
			gate: 2,
			name: "exact match",
			verdict: "miss",
			detail: candidate
				? "hash hit but the original text differs (a collision), treated as a miss"
				: "no byte-identical entry",
		});

		/* ③ Vector recall */
		const [matchVector] = await recall.scorer.embedQuestions([prompt.matchText]);
		// Already computed, so fill in the ticket while we are here and spare the write path another
		// embedding. ttlMs has to come along — this is an overwriting assignment, and omitting it would
		// wipe out the policy TTL prepareWrite recorded.
		ticket = { scope, shared, matchHash, matchVector, ttlMs: policyTtlMs };
		const returned = await options.store.searchNearest(scope, matchVector, recallLimit);

		/**
		 * **Re-check the scope on what comes back; do not trust the store's pre-filter.**
		 *
		 * `searchNearest`'s contract is "return only same-scope, unexpired entries" (see DESIGN.md,
		 * "two hard requirements for a store implementation") — but that is a **contract**, not a
		 * **check**. Gate ② already guards itself by the same rule (comparing the original text after
		 * a hash hit); gate ③ used not to, and ③ failing is far worse: one mis-written filter on the
		 * pgvector or Redis side returns another course's or another organization's answer across
		 * scopes, completely silently (the vectors compute, the similarity is high, and the trace looks
		 * entirely normal).
		 *
		 * The cost here is one extra string comparison — the entries are already in hand, so there is
		 * no additional round trip.
		 *
		 * **Discard rather than throw.** One dirty row on the read path should not fail the whole
		 * request (the same family of trade-off as "absence of evidence is not guilt"); but how many
		 * were discarded goes into the trace faithfully — `foreign > 0` means a store implementation
		 * violated a hard requirement, and that is a defect someone has to see, not a tolerable
		 * steady state.
		 */
		const candidates = returned.filter(c => c.entry.scope === scope);
		const foreign = returned.length - candidates.length;
		const foreignNote =
			foreign > 0 ? ` · ⚠ discarded ${foreign} candidate(s) from another scope: the store pre-filter failed` : "";

		if (candidates.length === 0 || candidates[0].similarity < recall.thresholds.floor) {
			const top = candidates[0]?.similarity;
			trace.push({
				gate: 3,
				name: `vector recall top-${recallLimit}`,
				verdict: "exit",
				detail:
					(candidates.length === 0
						? "no candidates in this scope"
						: `top cosine ${top?.toFixed(4)} is below the recall floor`) + foreignNote,
				score: top,
			});
			return miss(3);
		}
		trace.push({
			gate: 3,
			name: `vector recall top-${recallLimit}`,
			verdict: "pass",
			detail: `${candidates.length} candidate(s)${foreignNote}`,
			score: candidates[0].similarity,
		});

		/* ④ Rerank. No RerankStage means no gate — with no degradation that would mix scales. */
		let best = candidates[0].entry;
		if (rerank) {
			const target = rerank.thresholds.target;
			/**
			 * Under `target: "answer"`, plan entries have **no comparable candidate**: `entry.answer` is
			 * the empty string for them. Only one of three treatments does not lie:
			 *
			 *   - score against the empty string → necessarily low, so gate ④ stops every plan entry,
			 *     with no error
			 *   - fall back to `matchText` → applies a θq calibrated for question-to-answer to
			 *     question-to-question scores, mixing scales
			 *   - **the gate does not apply to them** ← chosen
			 *
			 * The precedent is ⑤ (since removed), which did not apply to plan entries either: a gate
			 * that cannot score something must say so, not score it on a substitute scale.
			 *
			 * **But in a mixed scope, "does not apply" means "yields", and that has to be said
			 * plainly.** As long as one answer entry remains in the top-k, the winner is chosen among
			 * the answers — a plan entry does not get this reuse even ranked first by ③ (only when the
			 * whole top-k is plans does it take ③'s top-1).
			 *
			 * There is no fourth option: letting a plan's ③ cosine compete on one leaderboard against
			 * an answer's rerank score is the very scale mixing this comment opened by rejecting, just
			 * relocated. So the trade-off is "answers first", with the cost written faithfully into the
			 * trace (`skipNote` below) — in a mixed scope plans are starved by answers, and a caller
			 * that needs plans should give them a scope of their own.
			 */
			const rerankable =
				target === "answer" ? candidates.filter(c => c.entry.kind === "answer") : [...candidates];
			const skipped = candidates.length - rerankable.length;

			if (rerankable.length === 0) {
				trace.push({
					gate: 4,
					name: "rerank",
					verdict: "off",
					detail:
						`target = "answer", but all ${candidates.length} candidates are plan entries (no answer text to compare) — ` +
						"this gate does not apply to plans, so ③'s cosine ranking takes top-1",
				});
			} else {
				const scored: Array<{ entry: CacheEntry; score: number; similarity: number }> = [];
				for (const c of rerankable) {
					const candidateText = target === "answer" ? c.entry.answer : c.entry.matchText;
					scored.push({
						entry: c.entry,
						score: await rerank.scorer.score(prompt.matchText, candidateText),
						similarity: c.similarity,
					});
				}
				scored.sort((a, b) => b.score - a.score);
				best = scored[0].entry;
				const questionScore = scored[0].score;
				/**
				 * **The winner's own ③ cosine has to be reported.**
				 *
				 * ③'s floor only gates `candidates[0]` — that is the "is this candidate set worth
				 * looking at" threshold — while the winner here can be any entry in the top-k,
				 * including one whose cosine is far below `floor`. Reranking overturning ③'s ranking is
				 * by design, but the trace used to carry only top-1's cosine and the rerank score, so
				 * "the entry that got reused had a ③ of only 0.3" was visible nowhere.
				 *
				 * This project holds the same rule on `foreign > 0`: a trade-off is fine, but it has to
				 * be visible.
				 */
				const belowFloor = scored[0].similarity < recall.thresholds.floor;
				// Neutral wording: when this gate stops it there is no "winner", only "④'s highest scorer".
				const winnerNote =
					`; ③ cosine of ④'s highest scorer is ${scored[0].similarity.toFixed(4)}` +
					(belowFloor ? ` **below the recall floor ${recall.thresholds.floor}**` : "");
				const scaleNote = `${target === "answer" ? "question-to-answer" : "question-to-question"} scale`;
				// In a mixed scope "does not apply" means "yielded" — saying "does not apply" would suggest
				// they are still in the running.
				const skipNote =
					skipped === 0
						? ""
						: `; ${skipped} plan entry/entries fall outside this gate and yielded to answers`;
				if (questionScore < rerank.thresholds.floor) {
					trace.push({
						gate: 4,
						name: "rerank",
						verdict: "exit",
						detail:
							`score ${questionScore.toFixed(4)} is below the floor ${rerank.thresholds.floor} (${scaleNote}` +
							`, calibrated on: ${rerank.calibratedOn})${skipNote}${winnerNote}`,
						score: questionScore,
					});
					return miss(4);
				}
				trace.push({
					gate: 4,
					name: "rerank",
					verdict: "pass",
					detail:
						`passed (${scaleNote})${skipNote}${winnerNote}` +
						// Reusing an entry below ③'s floor is ④'s prerogative, but it has to be written down
						// that the prerogative was exercised.
						(belowFloor ? " — reranking overturned ③'s ranking" : ""),
					score: questionScore,
				});
			}
		} else {
			trace.push({
				gate: 4,
				name: "rerank",
				verdict: "off",
				detail: "no RerankStage supplied — the question side is gated by ③'s recall floor alone",
			});
		}

		return verify(best, prompt, trace, guard, issueTicket, false, { noCacheReason, noStoreReason });
	}

	/**
	 * The last check on a matched entry, and the hit bookkeeping. **No gate id in its trace, because
	 * there is no gate left here.**
	 *
	 * There used to be two steps below ④, and both are gone. ⑤ compared the entry's source-version
	 * fingerprint against the current one and evicted on a mismatch; the source dimension has been
	 * removed — an entry records the space it belongs to and nothing finer — so revised material is
	 * handled by `clearScope()` on that space instead of by a read-time verdict. That also means the
	 * read path no longer deletes anything at all, which is why `LookupResult` documents itself as
	 * never evicting.
	 *
	 * The other removed step, ⑥ answer validation, is described at the return below.
	 */
	async function verify(
		entry: CacheEntry,
		_prompt: CachePrompt,
		trace: Array<GateTrace>,
		guard: RedactionGuard,
		prepareWrite: () => Promise<WriteTicket>,
		wasExact: boolean,
		/**
		 * The policy's two reasons, passed through verbatim. `noCache` never reaches here (it returns
		 * ahead of the gates), but `noStore` does — even a legitimate write-back has to clear it first.
		 */
		reasons: { readonly noCacheReason: string | null; readonly noStoreReason: string | null },
	): Promise<LookupResult> {
		// Fail fast: redacted × shared × answer is a combination that is certain to be wrong, so throw early.
		guard(entry.kind);

		/**
		 * Past ④ it is a hit. **The read path ends here, with no retrieval.**
		 *
		 * There used to be a gate ⑥ answer validation here: take the old answer's vector, compute its
		 * cosine against the top-1 chunk retrieved this time, and refuse below θa. It corresponded
		 * exactly to two failures — same word different referent, and entity collapse — and both of
		 * those stem from **a lossy cache key**: anonymization removed the entity, and the
		 * disambiguating context stayed in `context` instead of the key. Put everything that
		 * determines the answer into the key and neither failure occurs; the fix belongs in key design
		 * and read-side conditions, not in a backstop on the answer side.
		 *
		 * Removing it also removed the read path's only `retriever.retrieve()` and one embedding.
		 */
		if (!shadow) {
			await options.store.touch(entry.id);
		}
		const real: LookupOutcome = wasExact ? "exact" : "reuse";
		return {
			outcome: shadow ? "shadow" : real,
			wouldHave: shadow ? real : null,
			payload: payloadOf(entry),
			entryId: entry.id,
			scope: entry.scope,
			exitedAt: null,
			trace,
			...reasons,
			prepareWrite,
		};
	}

	/* ------------------------------------------------------------------ *
	 * Writing
	 * ------------------------------------------------------------------ */

	/** Computes a write ticket from scratch when no lookup result is available. */
	async function prepareTicket(prompt: CachePrompt): Promise<WriteTicket> {
		/**
		 * **The policy has to be consulted here too.** Otherwise this is a back door around
		 * `CachePolicy`: skip `lookup`, ask for a ticket directly, and write. The whole point of that
		 * guard is that something judged uncacheable cannot be written, from the types through to
		 * runtime — skip this one check and the guard is merely advice.
		 */
		let ttlMs: number | null | undefined;
		if (options.policy) {
			const disposition = await options.policy(prompt);
			// Only noStore blocks a write. noCache says "do not read" and must not stop a legitimate write-back.
			if (disposition.noStore !== undefined) {
				await bypassTicket(disposition.noStore)();
			}
			ttlMs = disposition.ttlMs;
		}
		const { scope, shared } = await resolveScope(prompt);
		return {
			scope,
			shared,
			matchHash: matchKeyOf(prompt).matchHash,
			matchVector: (await recall.scorer.embedQuestions([prompt.matchText]))[0],
			ttlMs,
		};
	}

	/**
	 * A ticket must come from the `lookup()` of **the same prompt**. Mismatching them is a
	 * constructive certainty of a bug and completely silent, so it is blocked here:
	 *
	 * - **The text does not match**: the entry's `matchText` is this request's while its `matchHash`
	 *   and `matchVector` are the previous one's. Gate ② hashes this text and cannot find it; gate ③
	 *   recalls it by the old vector and then reranks it against this `matchText`. Such an entry, once
	 *   written, can never be read back.
	 * - **The scope does not match**: the same sentence with a different `context` (another course,
	 *   another tenant) puts the entry in the ticket's scope. That is worse than unreadable — it is a
	 *   cross-boundary write.
	 */
	function assertTicketMatches(
		ticket: WriteTicket,
		prompt: CachePrompt,
		scope: string,
		shared: boolean,
		matchHash: string,
	): void {
		if (ticket.matchHash !== matchHash) {
			throw new Error(
				`The write ticket is not for this prompt: the ticket's matchHash is ${ticket.matchHash}, ` +
					`while matchText "${prompt.matchText}" hashes to ${matchHash}. ` +
					"A ticket may only come from the same prompt's lookup().prepareWrite() — mixing them writes a cache entry that can never be read back.",
			);
		}
		if (ticket.scope !== scope || ticket.shared !== shared) {
			throw new Error(
				`The write ticket's isolation boundary does not match the prompt's: the ticket says ${ticket.scope} (${ticket.shared ? "shared" : "isolated"}), ` +
					`while this prompt now resolves to ${scope} (${shared ? "shared" : "isolated"}). ` +
					"The same sentence belongs to different scopes under different contexts, and writing by the ticket writes into the other one.",
			);
		}
	}

	/**
	 * Batch write. `write` is its single-item wrapper — one implementation, so vector spaces, version
	 * fingerprints and the redaction guard have one definition between them.
	 *
	 * **Batching is not about saving a few lines**: two batched encodings replace 2N individual
	 * calls. Seeding 30 distractor entries or backfilling from historical logs is the difference
	 * between 2 model calls and 60.
	 *
	 * The guard runs to completion before any encoding: redacted × shared × answer is a combination
	 * certain to be wrong, and there is no reason to pay for a whole batch of embeddings first.
	 */
	// Four sequential passes over the batch — resolve, guard, encode, write — deliberately kept in
	// one function because each pass must complete for every item before the next begins. That
	// ordering is the point (the guard runs before any encoding, the write before any eviction), and
	// it is not expressible if the passes live in separate functions called per item.
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: four ordered passes over a batch
	async function writeMany(items: ReadonlyArray<WriteItem>): Promise<Array<CacheEntry>> {
		if (items.length === 0) {
			return [];
		}

		/**
		 * The scope and the hash are **recomputed for every item**, ticket or no ticket — and then
		 * checked against the ticket.
		 *
		 * What a ticket saves is the embedding, not these two: they are cheap anyway (one string hash,
		 * one usually-pure `ScopeResolver` call), while a ticket paired with the wrong prompt is not.
		 * See assertTicketMatches.
		 */
		const prepared: Array<{
			scope: string;
			shared: boolean;
			matchHash: string;
			matchVector: ReadonlyArray<number> | null;
			ttlMs?: number | null | undefined;
		}> = [];
		for (const item of items) {
			const { scope, shared } = await resolveScope(item.prompt);
			const { matchHash } = matchKeyOf(item.prompt);
			const ticket = item.options?.ticket;
			if (ticket) {
				assertTicketMatches(ticket, item.prompt, scope, shared, matchHash);
			}
			/**
			 * **A write without a ticket must also clear the policy.**
			 *
			 * `ticket` is optional (absent, the vector is embedded here), so the "`noStore` ⇒ no
			 * ticket" guard only closes the `lookup` / `prepareTicket` route — a direct
			 * `write(prompt, payload)` is a front door left open, and the claim that an uncacheable
			 * prompt cannot be written from the types through to runtime would be empty. A ticketed
			 * write needs no re-check: the policy was consulted when the ticket was issued, and
			 * re-checking only pays for another policy call.
			 */
			let ttlMs = ticket?.ttlMs;
			if (!ticket && options.policy) {
				const disposition = await options.policy(item.prompt);
				if (disposition.noStore !== undefined) {
					await bypassTicket(disposition.noStore)();
				}
				ttlMs = disposition.ttlMs;
			}
			prepared.push({ scope, shared, matchHash, matchVector: ticket?.matchVector ?? null, ttlMs });
		}

		// The guard has to precede the put — throwing after the row has landed means the cache is already polluted.
		for (let i = 0; i < items.length; i++) {
			makeRedactionGuard(items[i].prompt, prepared[i].scope, prepared[i].shared)(items[i].payload.kind);
		}

		/* Encode every missing recall vector in one call. */
		const missing: Array<number> = [];
		for (let i = 0; i < prepared.length; i++) {
			if (prepared[i].matchVector === null) {
				missing.push(i);
			}
		}
		if (missing.length > 0) {
			const vectors = await recall.scorer.embedQuestions(missing.map(i => items[i].prompt.matchText));
			for (let k = 0; k < missing.length; k++) {
				prepared[missing[k]].matchVector = vectors[k];
			}
		}

		const written: Array<CacheEntry> = [];
		for (let i = 0; i < items.length; i++) {
			const { prompt, payload } = items[i];
			const slot = prepared[i];
			const isAnswer = payload.kind === "answer";
			const created = now();
			// An explicit ttlMs wins (including null, meaning never expire), then the policy's value carried
			// on the ticket, and only then the global default.
			const ttl =
				items[i].options?.ttlMs !== undefined
					? items[i].options?.ttlMs
					: slot.ttlMs !== undefined
						? slot.ttlMs
						: ttlMs;

			const entry: CacheEntry = {
				id: newId(),
				scope: slot.scope,
				kind: payload.kind,
				matchText: prompt.matchText,
				matchHash: slot.matchHash,
				matchVector: slot.matchVector ?? [],
				answer: isAnswer ? payload.answer : "",
				plan: isAnswer ? {} : payload.plan,
				createdAt: created,
				expiresAt: ttl === null || ttl === undefined ? null : created + ttl,
				meta: items[i].options?.meta,
			};
			/**
			 * Before writing, check whether an entry for the same question already exists.
			 *
			 * Concurrent misses are the only source of these: single-flight covers one process and
			 * cannot cover several — two processes each generate and each write, leaving two rows
			 * sharing one `(scope, matchHash)`. This one query shrinks the duplicate window from **the
			 * whole generation time** (seconds) to **one round trip** (milliseconds), and two
			 * generations almost never finish in the same millisecond.
			 *
			 * **Compare the original text, not just the hash.** `matchHash` is not cryptographic, and a
			 * collision means two completely different questions — they should coexist rather than
			 * overwrite each other. This is exactly what gate ② does on the read path (comparing the
			 * original after a hash hit); here the same rule is applied on the write side.
			 *
			 * There is no unique index on `(scope, match_hash)`: that would turn one collision into two
			 * questions permanently evicting each other, and it would require a schema change, a change
			 * to `put`'s semantics, and another change to `entryId`'s semantics. Duplicate rows are
			 * **benign** (`getByHash` deterministically takes the newest, and gate ③ at worst wastes one
			 * candidate slot), which is not worth a contract change. See DESIGN.md's concurrency
			 * section.
			 */
			const normalized = normalizeKey(prompt.matchText);
			const existing = await options.store.getByHash(slot.scope, slot.matchHash);
			const duplicate =
				existing &&
				existing.id !== items[i].options?.supersedes &&
				normalizeKey(existing.matchText) === normalized
					? existing.id
					: null;

			await options.store.put(entry);

			// Write, then delete. With more than two rows only one is collected per pass, converging over
			// later writes — the read path is unaffected either way.
			for (const stale of new Set([items[i].options?.supersedes, duplicate])) {
				if (stale !== undefined && stale !== null) {
					await options.store.evict(stale);
				}
			}
			written.push(entry);
		}
		return written;
	}

	/**
	 * Write one cache entry. `resolve`'s generation path goes through here too.
	 *
	 * `options.ticket` carries the scope / hash / vector already computed by that `lookup()`; omit it
	 * and they are computed now, at the cost of one more scope resolution and one more embedding.
	 */
	async function write(
		prompt: CachePrompt,
		produced: CachedPayload,
		writeOptions?: WriteOptions,
	): Promise<CacheEntry> {
		const [entry] = await writeMany([{ prompt, payload: produced, options: writeOptions }]);
		return entry;
	}

	/* ------------------------------------------------------------------ *
	 * Reading and invalidation
	 * ------------------------------------------------------------------ */

	/** Fetch an entry by id. Only unexpired entries are returned — for the raw state including expired-but-uncleaned rows, use the store's `all()`. */
	function get(entryId: string): Promise<CacheEntry | null> {
		return options.store.getById(entryId);
	}

	/** Delete one entry or a batch. The batch form is what makes "clean up according to a lookup result" workable. */
	async function evict(entryId: string | ReadonlyArray<string>): Promise<void> {
		for (const id of typeof entryId === "string" ? [entryId] : entryId) {
			await options.store.evict(id);
		}
	}

	/**
	 * Clear one scope, returning how many were deleted. Archiving a course, closing a tenant account,
	 * or a teacher asking for a reset all go through here.
	 *
	 * **Takes `{ org, key }`, not a pre-joined string.** It used to take the output of
	 * `composeScope()`, so the spelling that omits the organization id — `clear("course:ml101")` —
	 * deleted 0 rows, returned 0, raised nothing, and left the caller believing the course was
	 * archived. That is precisely the silent failure this library keeps guarding against, and the
	 * examples in the README and `example/Smoke.ts` were written that way at the time: `npm run
	 * smoke` had been printing "deleted 0" all along and nobody spotted that it was wrong. With the
	 * joining moved into the library, that spelling no longer exists.
	 *
	 * **A scope is required.** An argument-free clear-everything is almost always a mistake in
	 * production; if you genuinely want one, call `InspectableCacheStore.clear()` on the store — let
	 * it be conspicuous rather than hidden behind a method on the cache object.
	 */
	// Throws synchronously when a JavaScript caller passes a pre-joined string, and `async` is what
	// turns that into a rejection rather than letting it escape at the call site — the tests assert
	// on a rejection.
	// biome-ignore lint/suspicious/useAwait: async is load-bearing, see above
	async function clear(scope: { readonly org: string; readonly key: string }): Promise<number> {
		// A JavaScript caller can get around the types. The old signature took a string, and silently
		// deleting 0 rows is exactly the failure being eliminated.
		if (typeof scope === "string") {
			throw new Error(
				`clear() takes { org, key }, not a pre-joined scope string (received ${JSON.stringify(scope)}). ` +
					"A string missing the organization id would delete 0 rows without raising anything, so the joining is the library's job: clear({ org, key }).",
			);
		}
		return options.store.clearScope(composeScope(scope.org, scope.key));
	}

	/**
	 * Delete expired entries, returning how many were deleted.
	 *
	 * **It does not affect correctness** — the read path already keeps expired entries out. Skip it
	 * and expired rows stay in the store forever, and on pgvector they additionally slow down the
	 * exact KNN within a scope. A periodic job is enough.
	 */
	function purgeExpired(): Promise<number> {
		return options.store.purgeExpired();
	}

	/* ------------------------------------------------------------------ *
	 * Composition: match → reuse on a hit, generate and write back on a miss
	 * ------------------------------------------------------------------ */

	/**
	 * Replacing an old entry: **write the new one first, and only delete the old one once that
	 * succeeded.**
	 *
	 * The other way round (delete then write) reads as more intuitive, but it turns "replace" into
	 * "delete, then try to write one": generation throwing, the write throwing, or the product having
	 * no source basis — any of them loses the old entry for nothing. It was measured once: one failed
	 * generation meant net-losing a cache entry that was still perfectly usable, which is exactly
	 * what the "an outage does not change cache state" invariant exists to prevent (refusing to write
	 * an answer with no basis is the other half of the same rule).
	 *
	 * With the order reversed, two rows sharing one (scope, matchHash) coexist for a few milliseconds
	 * — and that is safe: `getByHash`'s contract is to take the newest, so a read always sees the
	 * replacement.
	 */

	/**
	 * The single-flight key.
	 *
	 * **`retrievalText` has to be in the key.** When the caller anonymizes, two students asking the
	 * same sentence produce the same `matchText` while the entities in `retrievalText` differ — so
	 * different chunks are retrieved and a different answer is generated. Merging on `matchText`
	 * alone hands the later student an answer retrieved and generated from **somebody else's
	 * entities**. That is not a hit-rate problem, it is a wrong answer.
	 *
	 * **The resolved scope has to be in the key too.** All four `CachePrompt` fields are already
	 * there, so as long as `ScopeResolver` is a pure function of the prompt, the scope is a function
	 * of them — but that is a **contract**, not a **check**, and this library applies the same rule
	 * to gate ③'s store pre-filter (re-checking the scope on what comes back). A resolver that reads
	 * the tenant from outside the request (AsyncLocalStorage, a request header — very common shapes
	 * in multi-tenant systems) merges the same sentence from two tenants and **hands the later tenant
	 * an answer from the earlier tenant's cache**. The write path is guarded by the ticket's scope
	 * comparison; the read-hit path previously had nothing guarding it.
	 *
	 * The cost is one extra `ScopeResolver` call per `resolve` (the merge decision has to come after
	 * resolution). `writeMany` already pays the same price for the same reason: there too the scope is
	 * recomputed per item, ticket or not, because a usually-pure call is cheap and a mismatched scope
	 * is not.
	 *
	 * **The separator must be `\u0000` and not `=` / `&`.** Context used to be joined as `k=v&k=v`, so
	 * `{a: "b&c=d"}` and `{a: "b", c: "d"}` produced the same key — two different requests merged,
	 * and **the later one received the earlier one's answer**. That is not an efficiency problem but a
	 * wrong answer: in a teaching context this map holds courseId / userId / unit, any of which may
	 * contain those two characters.
	 *
	 * Using a character that cannot appear in a text field is cheaper than escaping — the same rule in
	 * `Scope.ts` escapes instead, because that value is stored and read by humans.
	 */
	function flightKey(scope: string, prompt: CachePrompt): string {
		const context = Object.entries(prompt.context)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.flatMap(([k, v]) => [k, v]);
		return [
			scope,
			normalizeKey(prompt.matchText),
			prompt.retrievalText,
			context.join("\u0000"),
			prompt.redacted ? "1" : "0",
		].join("\u0000\u0000");
	}

	/**
	 * Concurrent identical questions run the full pipeline once, and later requests receive the same
	 * result.
	 *
	 * Without it, N concurrent misses each generate and each write — N LLM calls, plus N duplicate
	 * entries of which only one can ever be hit by gate ②.
	 *
	 * **Merged requests share the first request's `generate` and `writeOptions`** (and share one
	 * trace — that trace faithfully records the one decision that actually happened). So a later
	 * caller's `meta` has no effect. Merging happens within one process only; duplicate generation
	 * across processes is waste rather than error, and introducing a distributed lock for it has a
	 * larger failure surface than the cost it saves.
	 */
	const flights = new Map<string, Promise<CacheResult>>();

	async function resolve(prompt: CachePrompt, generate: Generate, writeOptions?: WriteOptions): Promise<CacheResult> {
		if (!singleFlight) {
			return resolveOnce(prompt, generate, writeOptions);
		}
		// Resolve the scope before merging — it has to go into the key; see flightKey.
		const { scope } = await resolveScope(prompt);
		const key = flightKey(scope, prompt);
		const running = flights.get(key);
		if (running) {
			return running;
		}
		const started = resolveOnce(prompt, generate, writeOptions).finally(() => flights.delete(key));
		flights.set(key, started);
		return started;
	}

	// Composes lookup with generation, and the branching is the outcome matrix: bypass, hit, and the
	// several no-write paths (no source basis, shadow suppression, policy noStore). Each arm returns
	// a different CacheResult shape, and collapsing them would mean assembling one incrementally.
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one outcome per arm
	async function resolveOnce(
		prompt: CachePrompt,
		generate: Generate,
		writeOptions?: WriteOptions,
	): Promise<CacheResult> {
		const found = await lookup(prompt);
		const trace: Array<GateTrace> = [...found.trace];

		/**
		 * `noCache`: the cache was not consulted and generation runs as usual. **Whether anything is
		 * written is decided separately by `noStore`** — both switches set is "and the second one?",
		 * while only `noCache` is "answer again": the new answer must be written back over the old
		 * one, or every student who hits retry pays for their own generation while every better answer
		 * computed is thrown away.
		 */
		if (found.outcome === "bypass") {
			const bypassChunks = await options.retriever.retrieve(prompt.retrievalText, prompt.context);
			const produced = await generate(prompt, bypassChunks);
			// In shadow mode a bypass writes nothing either: no gate ran, so there is no way to know
			// whether the write would deduplicate over an existing entry.
			const storable = !shadow && found.noStoreReason === null;
			const stored = storable
				? await write(prompt, produced, { ...writeOptions, ticket: await found.prepareWrite() })
				: null;
			return {
				payload: produced,
				outcome: "bypassed",
				bypassReason: found.noCacheReason,
				wouldReuse: null,
				exitedAt: null,
				// null means it was generated but nothing landed in the cache.
				entryId: stored?.id ?? null,
				scope: found.scope,
				trace,
			};
		}

		if (found.payload && (found.outcome === "exact" || found.outcome === "reuse")) {
			return {
				payload: found.payload,
				outcome: found.outcome,
				bypassReason: null,
				// In shadow mode a hit has already been downgraded to "shadow" and never reaches here.
				wouldReuse: null,
				exitedAt: null,
				entryId: found.entryId,
				scope: found.scope,
				trace,
			};
		}

		/**
		 * This used to be the **mid band**: when ⑥'s support score fell between low and high, a short
		 * generation (`refine`) combined the old answer with the new chunks and wrote the result back,
		 * with `supersedes` displacing the old entry. The mid band was a product of ⑥ — with no support
		 * score there is no "not confident enough" state — so removing ⑥ removed it, `refine`, and the
		 * displace-the-old-entry write path along with it: a hit is a hit, and a miss writes a new entry.
		 */
		// `lookup` no longer retrieves (⑥ was its only reason), so this call before generation is the
		// only one.
		const chunks = await options.retriever.retrieve(prompt.retrievalText, prompt.context);
		const produced = await generate(prompt, chunks);
		// Whichever gate stopped the read (3 or 4, or null on a genuine no-candidate miss). The several
		// no-write return paths below share this one value, so the same situation cannot end up with
		// different `exitedAt`s in different branches.
		const exitedAt = found.exitedAt;

		/**
		 * **Shadow mode's write suppression has to come before `noStore`.**
		 *
		 * Placed after it, a request that would have hit but was stopped by `noStore` lands in the
		 * `noStore` branch and reports `wouldReuse: false` — while `noStore` governs writing and not
		 * reading, so it would in fact have been reused, and shadow mode's numerator is understated.
		 *
		 * It used to cover more than downgraded hits: while ⑤ and ⑥ existed, a **negative verdict on
		 * an existing entry** also had to suppress the write, or `writeMany`'s deduplication would
		 * evict the retained row as a duplicate and break the "shadow mode is read-only" promise from
		 * the write path. Both of those gates are gone, and the two that remain (3/4) plus a genuine
		 * no-candidate miss cannot collide with deduplication — so a downgraded hit is now the only
		 * case, and the condition is just that.
		 */
		if (shadow && found.outcome === "shadow") {
			trace.push({
				gate: 5,
				name: "shadow mode",
				verdict: "off",
				detail: `would have been ${found.wouldHave} — really generated instead, and not written back (the original entry is retained)`,
			});
			return {
				payload: produced,
				outcome: "generated",
				bypassReason: null,
				wouldReuse: true,
				exitedAt: null,
				entryId: found.entryId,
				scope: found.scope,
				trace,
			};
		}
		if (found.noStoreReason !== null) {
			trace.push({
				gate: 5,
				name: "write",
				verdict: "off",
				detail: `the policy refused the write (${found.noStoreReason}) — generated, but nothing landed in the cache`,
			});
			return {
				payload: produced,
				outcome: "generated",
				bypassReason: null,
				wouldReuse: shadow ? false : null,
				exitedAt,
				entryId: null,
				scope: found.scope,
				trace,
			};
		}
		const stored = await write(prompt, produced, { ...writeOptions, ticket: await found.prepareWrite() });
		return {
			payload: produced,
			outcome: "generated",
			bypassReason: null,
			wouldReuse: shadow ? false : null,
			exitedAt,
			// The entry just written. This used to be permanently null — an entry was written and its id
			// was unobtainable.
			entryId: stored.id,
			scope: found.scope,
			trace,
		};
	}

	return {
		resolve,
		lookup,
		write,
		writeMany,
		get,
		evict,
		clear,
		purgeExpired,
		prepareTicket,
		recallLimit,
	};
}

export type SemanticCache = ReturnType<typeof createSemanticCache>;
