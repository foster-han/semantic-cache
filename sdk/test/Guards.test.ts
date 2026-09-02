/**
 * Two guards against combinations that are certain to be wrong: redacted × shared scope × answer,
 * and a write ticket paired with the wrong prompt. Both fail completely silently — the symptom is
 * somebody receiving another person's answer days later, or a cache entry that can never be read
 * back.
 */

import type { CachedPayload } from "../src/types/Pipeline.ts";
import { harness } from "./Fakes.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const REDACTED = {
	matchText: "<PERSON_1> 的作业二扣了多少？",
	retrievalText: "张三的作业二扣了多少？",
	redacted: true,
	context: { userId: "s1" },
};
const answer = async (): Promise<CachedPayload> => ({ kind: "answer", answer: "扣了 10 分" });
const plan = async (): Promise<CachedPayload> => ({ kind: "plan", plan: { tool: "getGrade", assignment: "2" } });

test("a blank matchText is refused — empty strings are ② exact hits for one another", async () => {
	/**
	 * `""` and `"   "` normalize to the same empty string. One upstream occurrence of "the prompt
	 * assembled to nothing" written to the cache, and every later empty prompt **hits it exactly** —
	 * by the most trusted path there is, with no gates, no similarity, and a trace that looks
	 * entirely normal. So this throws rather than treating it as a miss (treated as a miss it would
	 * be written as usual, leaving the source of that false hit in the store).
	 */
	const { cache, store } = harness();
	const blank = { matchText: "   ", retrievalText: "x", context: {} };
	await assert.rejects(() => cache.lookup(blank), /matchText is empty/u);
	await assert.rejects(() => cache.resolve({ ...blank, matchText: "" }, answer), /matchText is empty/u);
	await assert.rejects(
		() => cache.write({ ...blank, matchText: "\t\n" }, { kind: "answer", answer: "a" }),
		/matchText is empty/u,
	);
	await assert.rejects(() => cache.prepareTicket(blank), /matchText is empty/u);
	assert.equal((await store.all()).length, 0, "not one entry should have been written");
});

test("redacted × shared scope × answer: throws outright, and names the three ways out", async () => {
	const { cache } = harness({ scope: () => ({ key: "course:1", shared: true, org: "org:1" }) });
	await assert.rejects(cache.resolve(REDACTED, answer), (err: Error) => {
		assert.match(err.message, /A redacted request hit or wrote an answer entry in shared scope/u);
		assert.match(err.message, /shared: false/u, "it has to tell the caller how to isolate");
		assert.match(err.message, /kind:"plan"/u, "and which route a tool-shaped question should take");
		return true;
	});
});

test("redacted × shared scope × plan: this is the point, and must not be blocked", async () => {
	const { cache, store } = harness({ scope: () => ({ key: "course:1", shared: true, org: "org:1" }) });
	const first = await cache.resolve(REDACTED, plan);
	assert.equal(first.outcome, "generated");
	// Another student asks the same sentence (identical after redaction) — on this branch the
	// collapse is the benefit.
	const second = await cache.resolve(
		{ ...REDACTED, retrievalText: "李四的作业二扣了多少？", context: { userId: "s2" } },
		plan,
	);
	assert.equal(second.outcome, "exact");
	assert.equal((await store.all()).length, 1, "one plan template serves everyone");
});

test("the guard applies on the hit path too — if an undeclared write got in, the read must still be blocked", async () => {
	let redacted = false;
	const { cache } = harness({ scope: () => ({ key: "course:1", shared: true, org: "org:1" }) });
	// First write into the shared scope without declaring redaction.
	await cache.resolve({ ...REDACTED, redacted }, answer);
	redacted = true;
	await assert.rejects(cache.lookup({ ...REDACTED, redacted }), /shared scope/u);
});

test("the guard runs before any encoding — do not pay for a whole batch of embeddings first", async () => {
	const { cache, counts } = harness({ scope: () => ({ key: "course:1", shared: true, org: "org:1" }) });
	await assert.rejects(
		cache.writeMany([
			{ prompt: REDACTED, payload: { kind: "answer", answer: "a" } },
			{ prompt: REDACTED, payload: { kind: "answer", answer: "b" } },
		]),
		/shared scope/u,
	);
	assert.equal(counts.questions, 0, "no recall vector should have been encoded");
});

test("a write ticket paired with the wrong prompt: mismatched text must throw", async () => {
	const { cache } = harness();
	const found = await cache.lookup({ matchText: "问题 A", retrievalText: "问题 A", context: {} });
	const ticket = await found.prepareWrite();
	await assert.rejects(
		cache.write(
			{ matchText: "问题 B", retrievalText: "问题 B", context: {} },
			{ kind: "answer", answer: "x" },
			{ ticket },
		),
		/is not for this prompt/u,
	);
});

test("a write ticket paired with the wrong prompt: a mismatched scope must throw (worse than unreadable — it is a cross-boundary write)", async () => {
	const { cache } = harness({
		scope: prompt => ({ key: `course:${prompt.context.courseId ?? "-"}`, shared: true, org: "org:1" }),
	});
	const found = await cache.lookup({ matchText: "问题 A", retrievalText: "问题 A", context: { courseId: "1" } });
	const ticket = await found.prepareWrite();
	await assert.rejects(
		cache.write(
			{ matchText: "问题 A", retrievalText: "问题 A", context: { courseId: "2" } },
			{ kind: "answer", answer: "x" },
			{ ticket },
		),
		/isolation boundary does not match/u,
	);
});

test("the ticket is a memoized function rather than a field — calling it repeatedly embeds once", async () => {
	const { cache, counts } = harness();
	const found = await cache.lookup({ matchText: "问题 A", retrievalText: "问题 A", context: {} });
	const before = counts.questions;
	const a = await found.prepareWrite();
	const b = await found.prepareWrite();
	assert.deepEqual(a, b);
	assert.equal(counts.questions, before, "③ already embedded once, so the ticket must not embed again");
});
