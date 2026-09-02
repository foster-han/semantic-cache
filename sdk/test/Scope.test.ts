/**
 * The isolation boundary: the organization id is required, joining must escape, and gate ③ has to
 * re-check the candidates it gets back.
 *
 * What these three share is that **they all fail in the direction of returning another tenant's
 * answer**, and completely silently: the vectors compute, the similarity is high, and the trace
 * looks entirely normal.
 */

import { createMemoryCacheStore } from "../src/MemoryCacheStore.ts";
import { composeScope } from "../src/Scope.ts";
import type { CacheStore, Candidate } from "../src/types/CacheStore.ts";
import { answering, harness } from "./Fakes.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const ASK = { matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} };

test("a missing org or key throws on the spot — even single-tenant has to name a value", () => {
	assert.throws(() => composeScope("", "course:1"), /ScopeDecision\.org is empty/u);
	assert.throws(() => composeScope("   ", "course:1"), /ScopeDecision\.org is empty/u);
	assert.throws(() => composeScope("org:1", ""), /ScopeDecision\.key is empty/u);
});

test("joining must escape — otherwise one org id containing the separator reads another's bucket", () => {
	// Without escaping, these two pairs join to the same string under `${org}|${key}`.
	assert.notEqual(composeScope("a", "b|c"), composeScope("a|b", "c"));
	assert.notEqual(composeScope("a\\", "b"), composeScope("a", "\\b"));
	// The same input must give the same output, or what was written cannot be read back.
	assert.equal(composeScope("org:1", "course:ml101"), composeScope("org:1", "course:ml101"));
});

test("the same key under different orgs never hits", async () => {
	const store = createMemoryCacheStore();
	const forOrg = (org: string) => harness({ store, scope: () => ({ key: "course:ml101", shared: true, org }) });

	const acme = forOrg("acme");
	await acme.cache.resolve(ASK, answering("acme's answer"));

	const globex = forOrg("globex");
	const probe = await globex.cache.resolve(ASK, answering("globex generated its own"));
	assert.equal(probe.outcome, "generated", "another organization must not hit acme's entry");
	assert.equal(probe.payload.kind === "answer" && probe.payload.answer, "globex generated its own");

	// Each can still read its own entry.
	const again = await acme.cache.resolve(ASK, answering("must not be called"));
	assert.equal(again.payload.kind === "answer" && again.payload.answer, "acme's answer");
});

test("clear takes { org, key } — a pre-joined string is the spelling that deletes 0 rows silently", async () => {
	const store = createMemoryCacheStore();
	const { cache } = harness({ store, scope: () => ({ key: "course:ml101", shared: true, org: "acme" }) });
	await cache.resolve(ASK, answering("acme's answer"));
	assert.equal((await store.all()).length, 1);

	// A string missing the org used to delete 0 rows, return 0, and raise nothing — and both the
	// README and the smoke example were written that way.
	await assert.rejects(
		() => cache.clear("course:ml101" as unknown as { org: string; key: string }),
		/clear\(\) takes \{ org, key \}/u,
	);
	assert.equal((await store.all()).length, 1, "nothing should be deleted before it throws");

	assert.equal(await cache.clear({ org: "acme", key: "course:ml101" }), 1);
	assert.equal((await store.all()).length, 0);
});

test("③ re-checks candidate scope — a failed store pre-filter must not let another tenant's entry be reused", async () => {
	const inner = createMemoryCacheStore();
	// A "broken store": searchNearest ignores scope and returns every entry.
	const leaky: CacheStore = {
		...inner,
		async searchNearest(_scope: string, _vector: ReadonlyArray<number>, limit: number): Promise<Array<Candidate>> {
			const all = await inner.all();
			return all.slice(0, limit).map(entry => ({ entry, similarity: 1 }));
		},
	};

	// Seed one entry for acme.
	const acme = harness({ store: leaky, scope: () => ({ key: "course:ml101", shared: true, org: "acme" }) });
	await acme.cache.resolve(ASK, answering("acme's answer"));

	// globex asks the same sentence. ② finds nothing (different scope), and ③ is fed one of acme's
	// entries by the broken store.
	const globex = harness({ store: leaky, scope: () => ({ key: "course:ml101", shared: true, org: "globex" }) });
	const found = await globex.cache.lookup(ASK);

	assert.equal(found.outcome, "miss", "a candidate from a foreign scope must be discarded, never counted as a hit");
	assert.equal(found.exitedAt, 3);
	const gate3 = found.trace.find(t => t.gate === 3);
	assert.match(
		String(gate3?.detail),
		/discarded 1 candidate\(s\) from another scope/u,
		"how many were discarded has to go into the trace faithfully",
	);
});
