import type { CachePrompt } from "./Pipeline.ts";

/**
 * Whether this prompt should enter the cache at all, decided ahead of every gate.
 *
 * **Why the five gates cannot do this.** Every gate asks whether a cached entry is **still** valid
 * — ③④ ask whether the questions are alike, ⑤ asks whether the sources have changed. But some
 * questions should **never have been written in the first place**:
 *
 * - "and the second one?" — outside this conversation, `matchText` is not even complete
 * - "submit my homework for me" — not a question at all, it is an action
 * - "give me five practice problems" — has no single correct answer
 *
 * Leaving these to the gates has two problems. First, you only discover the entry is unusable
 * after paying for recall, retrieval and support scoring, so you pay the full cost and save
 * nothing. Second, the gates **cannot stop the write** — the next identical question is then a
 * false hit. So the decision has to come first, and a `bypass` verdict **issues no write ticket**,
 * making the write impossible at the type level.
 *
 * **Try not to base the decision on the question text.** Phrasings are unbounded, and one missing
 * entry in a word list is a persistently wrong answer. Meanwhile an agent already decides, before
 * answering, whether to call tools, whether to feed history into the prompt, and whether this is an
 * explanation or a generation task — those three decisions yield the three categories above for
 * free, and far more accurately than a classifier. So this layer only defines the contract; the
 * signals arrive through `prompt.context`, the same channel `ScopeResolver` uses.
 */

/**
 * The disposition. All three fields absent means cache as usual.
 *
 * "Short TTL" is a number rather than a mode, so it sits alongside the two switches instead of
 * getting a category of its own — an extra mode would only make callers write two identical
 * branches in a `switch`.
 */
export interface CacheDisposition {
	/**
	 * Do not read the cache; the value is the reason. Same semantics as HTTP `Cache-Control: no-cache`.
	 *
	 * No gate runs; generation happens directly. **On its own** this means "answer again": skip the
	 * lookup and force regeneration, but write the new answer back over the old one — one student's
	 * dissatisfaction becomes an improvement for everyone after them.
	 */
	readonly noCache?: string;
	/**
	 * Do not write the cache; the value is the reason. Same semantics as HTTP `Cache-Control: no-store`.
	 *
	 * **No write ticket is issued** — this is not "skip the write this time", it is impossible to
	 * write, from the types through to runtime. On its own it means "you may read what others left,
	 * but do not store mine as the canonical answer".
	 */
	readonly noStore?: string;
	/**
	 * Override the global TTL. **Time-sensitive content belongs here, not in `noStore`.**
	 *
	 * "When is the assignment due" and "can I still submit it" are textually inseparable, and the
	 * question-side gates cannot separate them either — but both rest on the course schedule. Give a
	 * short TTL based on the nature of the source document and the two sentences need never be told
	 * apart. `null` means never expire; `undefined` means use the global value.
	 */
	readonly ttlMs?: number | null;
}

/**
 * The two switches are orthogonal, and all four combinations are useful:
 *
 * | noCache | noStore | Behaviour | When |
 * |---|---|---|---|
 * | — | — | Look up, reuse on a hit; generate and store on a miss | Almost every question |
 * | ✓ | ✓ | No lookup, generate, do not store | "and the second one?" |
 * | ✓ | — | No lookup, force generation, **write back over the old entry** | "answer again" |
 * | — | ✓ | Look up as usual, generate on a miss but do not store | "give me five practice problems" |
 *
 * The HTTP vocabulary is borrowed rather than a `bypass` of our own invention: every engineer
 * already understands these semantics, and they are natively split across the read and write sides
 * — a single boolean of our own could not express the middle two rows.
 */

/**
 * Same shape as `ScopeResolver`: supplied once at construction, consulted per request with `prompt`.
 *
 * Signals that vary per request (is this a follow-up, does the agent need tools) travel through
 * `prompt.context` — the existing per-request channel, so `lookup`'s signature need not change.
 */
export type CachePolicy = (prompt: CachePrompt) => Promise<CacheDisposition> | CacheDisposition;
