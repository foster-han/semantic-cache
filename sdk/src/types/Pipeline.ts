import type { Chunk } from "./Retrieval.ts";

/**
 * One question.
 *
 * Called a prompt rather than a request: it is the prompt from RedisVL's `store(prompt, …)` and
 * LangChain's `lookup(prompt, …)`, and has nothing to do with an HTTP request — in this repository
 * `req` already means lab/Server.ts's HTTP request, and the two concepts should not share a word.
 * It does not collapse to a plain string because, besides the question text, it has to carry
 * `redacted` (needed by the guard) and `context` (needed by `ScopeResolver` to decide the
 * isolation boundary).
 *
 * **`matchText` and `retrievalText` are two fields on purpose.** When the caller anonymizes PII,
 * the cache key must be built on the anonymized text (`matchText`) while retrieval must use the
 * entity-preserving original (`retrievalText`) — otherwise answer-side validation cannot catch
 * placeholder collapse. Applications that do not anonymize simply pass the same string as both.
 */
export interface CachePrompt {
	readonly matchText: string;
	readonly retrievalText: string;
	/**
	 * Whether the layer above redacted `matchText` (entities replaced by placeholders).
	 *
	 * When true, the SDK **refuses** to put this request into a shared scope. Redaction can collapse
	 * two different people onto one cache key while the answer still carries placeholders — reused
	 * across users and rehydrated with the current request's entity mapping, one person's answer
	 * comes back under another person's name. That is not a matter of probability but a
	 * constructive certainty, so it is blocked in the types and at runtime.
	 */
	readonly redacted?: boolean;
	/** Context handed to `Retriever` and `ScopeResolver` — courseId, unit, userId, and so on. */
	readonly context: Readonly<Record<string, string>>;
}

/**
 * A scope decision. All three fields are required — there is no shorthand where returning a bare
 * string implies a shared scope, because that would make `org` and `shared` forgettable, and each
 * of them fails silently.
 *
 * PII filtering stays above the SDK: the library knows nothing about PII, only about the isolation
 * boundary returned here.
 */
export interface ScopeDecision {
	/**
	 * The business isolation boundary — a course, a knowledge base, a space.
	 *
	 * **This is also the only record of what an entry was built from.** Entries do not track which
	 * documents an answer cited, so the space is both the isolation boundary and the invalidation
	 * unit: material changed means `clearScope()` on that space.
	 */
	readonly key: string;
	readonly shared: boolean;
	/**
	 * Organization / tenant id. **Required, and not substitutable by concatenating it into `key`.**
	 *
	 * Gate ③ is vector recall **within** a scope — with the question text absent from the key, this
	 * string is the only thing bucketing entries. Getting it wrong does not cost a hit, it
	 * **returns another tenant's answer**, and it does so completely silently. The library
	 * concatenates via `composeScope()` with escaping, so `("a", "b|c")` and `("a|b", "c")` land in
	 * different buckets — hand-built strings do not stop that class of mistake.
	 *
	 * Single-tenant deployments must still supply a fixed value (`"default"`, say), so that it is
	 * an explicit decision.
	 */
	readonly org: string;
}
/**
 * Decides which isolation boundary a question belongs to.
 *
 * **Must be a pure function of `prompt`.** The decision may only come from the arguments — that is
 * what `context` is for — and never from the environment outside the request: not a tenant in
 * AsyncLocalStorage, not a request header, not a module-level "current user". The library puts the
 * resolved scope into its in-process single-flight key, so an impure resolver merges the same
 * sentence from two tenants and hands the later tenant the earlier one's answer. If tenant
 * information is needed, put it in `prompt.context` and make it part of the request.
 */
export type ScopeResolver = (prompt: CachePrompt) => Promise<ScopeDecision> | ScopeDecision;

/**
 * ①–④ are the read gates; **⑤ is the write step**, which is not a gate at all.
 *
 * ⑤ used to be source-version comparison *and* the slot the write-side traces borrowed, so one id
 * meant two things. The source dimension has been removed — entries record the space they belong to
 * and nothing finer — which leaves ⑤ with the one meaning the code was already using it for.
 */
export type GateId = 1 | 2 | 3 | 4 | 5;

export type GateVerdict =
	| "pass"
	| "hit"
	| "miss"
	| "exit"
	/** This gate would have stopped it, but is switched off — used during A/B to see the cost. */
	| "would-exit"
	| "off";

export interface GateTrace {
	readonly gate: GateId;
	readonly name: string;
	readonly verdict: GateVerdict;
	readonly detail: string;
	readonly score?: number;
}

/**
 * **No step on the read path deletes anything, and there is no `evicted` flag to say one did.**
 *
 * ⑤ was the only gate that evicted: a source-version mismatch condemned the entry as it was read.
 * `GateTrace` therefore carried an `evicted` boolean, and `Metrics` counted it — with the rule that
 * an eviction must be *declared* by that field and never inferred from `verdict === "exit"`, since
 * inferring it made one upstream outage fill the dashboard with evictions the cache never
 * performed. With ⑤ gone nothing sets the flag, and a metric that is structurally always zero is
 * worse on a dashboard than no metric at all, so the field and its counter were removed together.
 *
 * Any future gate that deletes on a read has to bring both back — and the rule above with them.
 */

export type Outcome =
	/** Exact hit that passed every check. */
	| "exact"
	/** Semantic hit that passed every check. */
	| "reuse"
	/** Missed or stopped by a gate; full generation ran. */
	| "generated"
	/**
	 * `CachePolicy`'s `noCache` applied — **the cache was deliberately not consulted** and
	 * generation ran directly.
	 *
	 * Not folded into `generated`: that would make a policy bypass and a genuine miss identical on
	 * the dashboard, so "some upstream signal has been stuck on" shows up only as a falling hit
	 * rate with no way to find the cause. That is exactly the disease behind silent no-ops in
	 * frameworks like litellm.
	 */
	| "bypassed";

export interface CacheResult {
	/**
	 * The hit or newly generated payload. **The only way to read it.**
	 *
	 * There used to be an `answer: string` alongside it, empty for plans — reading `.answer` would
	 * silently yield an empty string with no error, precisely the failure this API keeps
	 * eliminating. It was removed; callers must `switch (payload.kind)`.
	 */
	readonly payload: CachedPayload;
	readonly outcome: Outcome;
	/**
	 * The `noCache` reason when `outcome === "bypassed"`, otherwise null.
	 *
	 * Metrics only have diagnostic value grouped by reason: knowing only that bypasses went up
	 * does not identify which rule, and an upstream signal stuck on is the most common silent
	 * failure in systems like this.
	 */
	readonly bypassReason: string | null;
	/**
	 * Under shadow mode, whether this request **would have** been reused; null outside shadow mode.
	 *
	 * The metrics layer computes the would-be hit rate from it — the number that decides whether to
	 * turn the cache on for real.
	 */
	readonly wouldReuse: boolean | null;
	/** Which gate stopped it; null when nothing did. */
	readonly exitedAt: GateId | null;
	/**
	 * The entry id this result corresponds to — **always one that currently exists in the store.**
	 *
	 * For `generated` it is the entry just written; for `refine` it is the replacement entry (the
	 * old one is already deleted, so returning the old id would give callers something that
	 * `get()` only answers with null).
	 */
	readonly entryId: string | null;
	/**
	 * The resolved scope this result belongs to — the space the answer was built from.
	 *
	 * **This replaced a `sourceIds` array.** Per-document basis is no longer tracked, so the space
	 * is the annotation: it says which body of material the answer rests on, and it is what
	 * `clearScope()` takes when that material is revised.
	 */
	readonly scope: string;
	readonly trace: ReadonlyArray<GateTrace>;
}

/** The caller's own generation. The library decides whether to call it, and passes in the already-retrieved chunks to avoid retrieving twice. */
export type Generate = (prompt: CachePrompt, chunks: ReadonlyArray<Chunk>) => Promise<CachedPayload>;

/**
 * What is stored — this distinction decides which gates apply, and whether redacted entries can be
 * shared across subjects.
 *
 * **answer**: a text answer containing entity-specific content. Once redacted it **cannot** be
 * shared across subjects, or one person's answer arrives under another's name.
 *
 * **plan**: a tool-call plan, where entities are **parameters** rather than content. At execution
 * time parameters are filled from the current request and authorization is checked there and then.
 * Once redacted, sharing across subjects **is the point** — one template serves everyone, and the
 * more thoroughly it collapses the more efficient the cache.
 *
 * The expensive part is the LLM deciding which tool to call with which arguments; the tool call
 * itself is cheap. So this branch caches the plan and not the result, and the result is fetched
 * live every time.
 */
export type CachedPayload =
	| {
			readonly kind: "answer";
			readonly answer: string;
	  }
	| {
			readonly kind: "plan";
			/** Tool name and arguments. Argument values are strings; serialize a richer plan yourself. */
			readonly plan: Readonly<Record<string, string>>;
	  };

/**
 * The request-independent derived information a write needs.
 *
 * `lookup()` has already resolved the scope once, hashed once, and (on most paths) embedded once.
 * Carrying those out to `write()` means that on the most common manual path — miss, generate
 * yourself, write back — the caller does not pay for a second embedding.
 *
 * **A ticket saves the embedding and nothing else.** `write()` recomputes the scope and the hash
 * every time and checks them against the ticket — both are cheap anyway (one string hash, one
 * usually-pure `ScopeResolver` call), whereas using question A's ticket to write question B's
 * answer produces a cache entry that can never be read back, possibly in the wrong scope. Saving
 * those two calls does not buy that risk.
 */
export interface WriteTicket {
	readonly scope: string;
	/** Whether the scope is shared — needed by the redaction guard. */
	readonly shared: boolean;
	readonly matchHash: string;
	/** PairEncoder space. */
	readonly matchVector: ReadonlyArray<number>;
	/**
	 * The TTL `CachePolicy` set for this entry, carried along with the ticket to the write path.
	 *
	 * Precedence: `WriteOptions.ttlMs` (explicitly given by the caller) > this > global `ttlMs`.
	 * A policy saying "this kind lives ten minutes" should not override the caller being explicit
	 * about one particular entry.
	 */
	readonly ttlMs?: number | null | undefined;
}

export type LookupOutcome =
	/** Exact hit that passed every check. */
	| "exact"
	/** Semantic hit that passed every check. */
	| "reuse"
	/** No usable entry. */
	| "miss"
	/**
	 * Shadow mode: **every gate ran, but the result does not count** — the real one is in
	 * `wouldHave`.
	 *
	 * The step most needed when rolling out a probabilistic cache: run the whole decision chain on
	 * production traffic while still generating for real every time, to answer "would enabling this
	 * return a wrong answer". So in shadow mode the read path is **strictly read-only** — no reuse,
	 * no eviction, no touch. An evaluation should not change the thing being evaluated.
	 */
	| "shadow"
	/**
	 * `CachePolicy`'s `noCache` applied — **not one gate ran**.
	 *
	 * Different from `miss`: a miss means it was looked up and not found, a bypass means it was
	 * never looked up. Note this says only that nothing was **read**; whether anything is written is
	 * decided by `noStoreReason`, and the two are orthogonal.
	 */
	| "bypass";

/**
 * The result of a read-only match.
 *
 * **`lookup` neither generates nor writes a new entry, and never evicts.** It used to evict entries
 * that ⑤ judged stale; with the source dimension gone there is no read-time verdict that can
 * condemn an entry, so the read path leaves the store untouched.
 */
export interface LookupResult {
	readonly outcome: LookupOutcome;
	/** The payload on a hit; null on a miss. */
	readonly payload: CachedPayload | null;
	readonly entryId: string | null;
	/** The resolved scope this lookup ran in — see `CacheResult.scope`. */
	readonly scope: string;
	/** Which gate stopped it; null on a hit. */
	readonly exitedAt: GateId | null;
	readonly trace: ReadonlyArray<GateTrace>;
	/**
	 * `CachePolicy`'s reason for "do not read"; null when it said nothing.
	 *
	 * On the result rather than in `trace`, because not one gate ran — recording it as some gate's
	 * verdict would be a lie. Non-null is equivalent to `outcome === "bypass"`.
	 */
	/**
	 * Under shadow mode, **what the result would have been**; null outside shadow mode.
	 *
	 * Necessarily non-null when `outcome === "shadow"`. Same idea as `GateVerdict`'s `would-exit`,
	 * lifted to the level of the whole chain.
	 */
	readonly wouldHave: LookupOutcome | null;
	readonly noCacheReason: string | null;
	/**
	 * `CachePolicy`'s reason for "do not write"; null when it said nothing.
	 *
	 * When non-null, `prepareWrite()` necessarily throws. Orthogonal to `noCacheReason`: "answer
	 * again" has only the former, "give me five practice problems" only the latter.
	 */
	readonly noStoreReason: string | null;
	/**
	 * Obtain a write ticket. **A function rather than a field**: the gate ② exact-hit path needs no
	 * recall vector at all, and paying for a model call to populate a field that will most likely go
	 * unused destroys exactly the value that layer provides. The result is memoized, so calling it
	 * repeatedly still computes once.
	 */
	prepareWrite(): Promise<WriteTicket>;
}

/** Write options. All three absent means "use the lookup's ticket, no meta, global TTL". */
export interface WriteOptions {
	/**
	 * The scope / hash / vector already resolved by that `lookup()`. Omit it and they are computed
	 * now — at the cost of one more scope resolution and one more embedding.
	 */
	readonly ticket?: WriteTicket;
	/** The caller's own bookkeeping fields (model name, request id, cost, …). The library does not interpret them. */
	readonly meta?: Readonly<Record<string, string>> | undefined;
	/**
	 * How long this entry lives, overriding the global `ttlMs`. `null` means never expire.
	 *
	 * Per-entry TTL is what makes "cache course-admin answers for a day, time-sensitive content for
	 * ten minutes" possible — with a single global value, the shortest requirement drags every
	 * entry's TTL down with it.
	 */
	readonly ttlMs?: number | null | undefined;
	/**
	 * The id of an old entry to evict after a successful write — for "replace" rather than "add".
	 *
	 * The order is **write, then delete**: the window contains two entries rather than zero. Better
	 * that a concurrent reader see a slightly stale entry than see a miss and generate another one;
	 * and if the write fails the old entry is still there.
	 */
	readonly supersedes?: string;
}

/** One item of a batch write. */
export interface WriteItem {
	readonly prompt: CachePrompt;
	readonly payload: CachedPayload;
	readonly options?: WriteOptions | undefined;
}
