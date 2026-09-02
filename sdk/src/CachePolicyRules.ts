import type { CacheDisposition, CachePolicy } from "./types/CachePolicy.ts";
import type { CachePrompt } from "./types/Pipeline.ts";

/**
 * A default policy built from **structural signals** alone.
 *
 * Structural signals are the booleans an agent's planning stage has already computed: does this
 * turn need tools, does the conversation history have to go into the prompt, is the task
 * explanation or generation. They are more accurate than any word list or classifier, and they are
 * already in the caller's hands — this layer only reads them out of `prompt.context` and makes no
 * judgement about text.
 *
 * **No keywords are built in, deliberately.** A word list like "now / today / latest" looks
 * convenient and is the most brittle option there is: one missing entry is a persistently wrong
 * answer, and every language needs its own list. To use a word list or a classifier, write your own
 * `CachePolicy` and pass it in, or chain it after this one with `combinePolicies`.
 */

/** Values in `context` treated as "this signal is absent". Any other value counts as set. */
const FALSY = new Set(["", "0", "false", "no", "off"]);

function isSet(context: Readonly<Record<string, string>>, key: string): boolean {
	const raw = context[key];
	return raw !== undefined && !FALSY.has(raw.trim().toLowerCase());
}

/**
 * Call types allowed through the **semantic** cache by default.
 *
 * There is one criterion: **is the output a deterministic function of the input?**
 *
 * - `completion` / `responses` / `anthropic_messages` — sampled, so the same input gives different
 *   outputs. "Can a similar question reuse this answer" is a real question here, and that is what
 *   the gates are for. **Included.**
 * - `embedding` — the same text necessarily gives the same vector. Matching it by similarity trades
 *   "roughly similar text" for "roughly similar vector", destroying the very meaning of the vector.
 *   **Belongs in an exact cache keyed by content hash.**
 * - `rerank` — the same query plus the same document set necessarily gives the same scores. As above.
 * - `transcription` — the same file necessarily gives the same transcript. Two "similar" recordings
 *   are not the same recording.
 * - `text_completion` — a legacy interface, and litellm cannot extract a prompt for it anyway.
 *
 * **Being excluded does not mean it should not be cached** — quite the opposite: the other four
 * belong in an exact cache, which carries zero false-hit risk and pays off on every hit, and should
 * be exploited first. They just do not belong in **this** layer.
 *
 * Async variants (the `a` prefix) need no separate entry; matching handles them.
 */
export const DEFAULT_SEMANTIC_CALL_TYPES: ReadonlyArray<string> = ["completion", "responses", "anthropic_messages"];

/**
 * Call-type matching. **The `a` prefix cannot be stripped blindly** — `anthropic_messages` itself
 * starts with an `a`, and stripping it yields `nthropic_messages` and a missed match. So the name is
 * checked first and the stripped name second: `anthropic_messages` matches on the first,
 * `aanthropic_messages` on the second.
 */
function isAllowedCallType(callType: string, allowed: ReadonlySet<string>): boolean {
	if (allowed.has(callType)) {
		return true;
	}
	return callType.startsWith("a") && allowed.has(callType.slice(1));
}

export interface StructuralPolicyOptions {
	/**
	 * `context` key → reason. A match means **do not read** the cache (`no-cache`), while writing
	 * proceeds as usual.
	 *
	 * "Answer again" belongs here: skip the lookup, force regeneration, and let the new answer
	 * replace the old entry.
	 */
	readonly noCacheWhen?: Readonly<Record<string, string>>;
	/**
	 * `context` key → reason. A match means **do not write** the cache (`no-store`), while reading
	 * proceeds as usual.
	 *
	 * "Give me five practice problems" belongs here: use someone else's if they asked already, but do
	 * not store mine as the canonical answer.
	 */
	readonly noStoreWhen?: Readonly<Record<string, string>>;
	/**
	 * `context` key → reason. Sets both — neither read nor write, the most common case.
	 *
	 * **Key names are the caller's to choose.** No magic strings like `needsHistory` are assumed
	 * here: such conventions get misspelled across repositories, and a misspelling makes the policy
	 * fail silently.
	 */
	readonly bypassWhen?: Readonly<Record<string, string>>;
	/** `context` key → TTL for this entry, in milliseconds. When several keys match, the **shortest** wins. */
	readonly shortTtlWhen?: Readonly<Record<string, number>>;
	/**
	 * Which `context` key says what kind of call this is. Defaults to `"callType"`.
	 *
	 * Use litellm's names for the values (`completion` / `embedding` / `rerank` / `transcription` /
	 * `responses` / `anthropic_messages` / `text_completion`, plus the `a`-prefixed async variants),
	 * so the gateway and this layer speak the same language.
	 */
	readonly callTypeKey?: string;
	/**
	 * Allowlist of call types permitted through the semantic cache. Defaults to
	 * {@link DEFAULT_SEMANTIC_CALL_TYPES}.
	 *
	 * Anything not listed gets `noCache` + `noStore`. **An allowlist rather than a denylist**:
	 * forgetting to configure a newly introduced call type costs "this kind did not use the semantic
	 * cache" (one missed hit, cheap) rather than "something that should never be matched semantically
	 * was" (a wrong answer, expensive).
	 */
	readonly allowedCallTypes?: ReadonlyArray<string>;
	/**
	 * What to do when `callTypeKey` is not set. Defaults to `false`, meaning let it through.
	 *
	 * Letting it through is reasonable because this library's only entry point is
	 * `resolve(prompt, generate)` and it only ever handles the chat shape — an unlabelled request is
	 * almost certainly that. But if you route several kinds of call into this layer, **turn it on**:
	 * then "forgot to label it" and "labelled it embedding" have very different consequences, and the
	 * former would silently run the full semantic match.
	 */
	readonly requireCallType?: boolean;
}

export function createStructuralPolicy(options: StructuralPolicyOptions = {}): CachePolicy {
	const noCacheWhen = options.noCacheWhen ?? {};
	const noStoreWhen = options.noStoreWhen ?? {};
	const bypassWhen = options.bypassWhen ?? {};
	const shortTtlWhen = options.shortTtlWhen ?? {};

	for (const [key, ttl] of Object.entries(shortTtlWhen)) {
		if (!Number.isFinite(ttl) || ttl <= 0) {
			throw new Error(
				`shortTtlWhen["${key}"]=${ttl} is not a positive number of milliseconds. For never expiring use ttlMs: null; to keep it out of the cache use noStoreWhen.`,
			);
		}
	}
	/**
	 * The four tables must have disjoint keys.
	 *
	 * With one key in two tables, which one wins can only be learned by reading the source — while
	 * the entire point of this layer is that "why was this not cached" has a definite answer.
	 * Rejecting outright beats defining a precedence.
	 */
	const seen = new Map<string, string>();
	for (const [table, keys] of [
		["noCacheWhen", Object.keys(noCacheWhen)],
		["noStoreWhen", Object.keys(noStoreWhen)],
		["bypassWhen", Object.keys(bypassWhen)],
		["shortTtlWhen", Object.keys(shortTtlWhen)],
	] as ReadonlyArray<[string, ReadonlyArray<string>]>) {
		for (const key of keys) {
			const previous = seen.get(key);
			if (previous !== undefined) {
				throw new Error(
					`context key "${key}" appears in both ${previous} and ${table}. Which one applies could only be learned from the source, so this is rejected outright — rename one, or merge them into a single rule.`,
				);
			}
			seen.set(key, table);
		}
	}

	const callTypeKey = options.callTypeKey ?? "callType";
	const allowedCallTypes = new Set(options.allowedCallTypes ?? DEFAULT_SEMANTIC_CALL_TYPES);
	const requireCallType = options.requireCallType ?? false;
	if (allowedCallTypes.size === 0) {
		throw new Error(
			"allowedCallTypes is empty, which disables the entire cache. If that is genuinely what you want, do not install this policy at all rather than expressing it as an empty allowlist.",
		);
	}

	// The branching is four independent table lookups plus the call-type allowlist, each producing
	// one field of the disposition. Splitting them into helpers would hide that they are independent
	// and reintroduce the question this layer exists to answer plainly: which rule decided.
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: flat, independent rule tables
	return function structuralPolicy(prompt: CachePrompt): CacheDisposition {
		let noCache: string | undefined;
		let noStore: string | undefined;

		const callType = prompt.context[callTypeKey]?.trim();
		if (callType === undefined || callType === "") {
			if (requireCallType) {
				const reason = `no call type labelled (context.${callTypeKey}) — unlabelled requests are not let through while requireCallType is on`;
				noCache = reason;
				noStore = reason;
			}
		} else if (!isAllowedCallType(callType, allowedCallTypes)) {
			const reason = `call type "${callType}" is not on the semantic-cache allowlist — its output is a deterministic function of its input, so it belongs in an exact cache rather than similarity matching`;
			noCache = reason;
			noStore = reason;
		}
		for (const [key, reason] of Object.entries(bypassWhen)) {
			if (isSet(prompt.context, key)) {
				noCache ??= reason;
				noStore ??= reason;
			}
		}
		for (const [key, reason] of Object.entries(noCacheWhen)) {
			if (isSet(prompt.context, key)) {
				noCache ??= reason;
			}
		}
		for (const [key, reason] of Object.entries(noStoreWhen)) {
			if (isSet(prompt.context, key)) {
				noStore ??= reason;
			}
		}
		let ttlMs: number | undefined;
		for (const [key, ttl] of Object.entries(shortTtlWhen)) {
			if (isSet(prompt.context, key)) {
				ttlMs = ttlMs === undefined ? ttl : Math.min(ttlMs, ttl);
			}
		}
		const disposition: { noCache?: string; noStore?: string; ttlMs?: number } = {};
		if (noCache !== undefined) {
			disposition.noCache = noCache;
		}
		if (noStore !== undefined) {
			disposition.noStore = noStore;
		}
		if (ttlMs !== undefined) {
			disposition.ttlMs = ttlMs;
		}
		return disposition;
	};
}

/**
 * Try policies in order. `noCache` and `noStore` **each independently** take the first reason to say
 * no, and the TTL takes the shortest.
 *
 * The two switches merge separately because they are orthogonal: one policy saying "do not write
 * this" and another saying "do not read this" should leave both in force, not have one override the
 * other. The TTL takes the shortest rather than the last — when two policies believe "at most ten
 * minutes" and "at most a day", the only safe merge is ten minutes.
 */
export function combinePolicies(...policies: ReadonlyArray<CachePolicy>): CachePolicy {
	if (policies.length === 0) {
		throw new Error("combinePolicies needs at least one policy — zero policies is no policy, so do not pass any.");
	}
	return async function combined(prompt: CachePrompt): Promise<CacheDisposition> {
		let noCache: string | undefined;
		let noStore: string | undefined;
		let ttlMs: number | null | undefined;
		for (const policy of policies) {
			const decision = await policy(prompt);
			noCache ??= decision.noCache;
			noStore ??= decision.noStore;
			if (decision.ttlMs === undefined) {
				continue;
			}
			// null means never expire, the loosest setting, so it must not override any finite value.
			if (decision.ttlMs === null) {
				ttlMs = ttlMs === undefined ? null : ttlMs;
			} else {
				ttlMs = typeof ttlMs === "number" ? Math.min(ttlMs, decision.ttlMs) : decision.ttlMs;
			}
		}
		const disposition: { noCache?: string; noStore?: string; ttlMs?: number | null } = {};
		if (noCache !== undefined) {
			disposition.noCache = noCache;
		}
		if (noStore !== undefined) {
			disposition.noStore = noStore;
		}
		if (ttlMs !== undefined) {
			disposition.ttlMs = ttlMs;
		}
		return disposition;
	};
}
