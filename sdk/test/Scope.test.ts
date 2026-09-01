/**
 * 隔离边界：组织 id 必填、拼接必须转义、③ 拿回候选后要复核。
 *
 * 这三件事的共同点是**失效方向都是「跨租户返回别人的答案」**，而且完全静默：
 * 向量照样算得出来、相似度照样很高、trace 上一切正常。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { composeScope } from "../src/Scope.ts";
import { createMemoryCacheStore } from "../src/MemoryCacheStore.ts";
import type { CacheStore, Candidate } from "../src/types/CacheStore.ts";
import { answering, harness } from "./Fakes.ts";

const ASK = { matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} };

test("org 或 key 缺失时当场抛 —— 单租户也要显式给一个值", () => {
	assert.throws(() => composeScope("", "course:1"), /ScopeDecision\.org 是空的/u);
	assert.throws(() => composeScope("   ", "course:1"), /ScopeDecision\.org 是空的/u);
	assert.throws(() => composeScope("org:1", ""), /ScopeDecision\.key 是空的/u);
});

test("拼接必须转义 —— 否则一个带分隔符的 org id 就能读到别人的桶", () => {
	// 不转义的话 `${org}|${key}` 下这两组会拼成同一个字符串
	assert.notEqual(composeScope("a", "b|c"), composeScope("a|b", "c"));
	assert.notEqual(composeScope("a\\", "b"), composeScope("a", "\\b"));
	// 同样的输入必须得到同样的输出，否则写进去的读不回来
	assert.equal(composeScope("org:1", "course:ml101"), composeScope("org:1", "course:ml101"));
});

test("同一个 key、不同 org 互不命中", async () => {
	const store = createMemoryCacheStore();
	const forOrg = (org: string) =>
		harness({ store, scope: () => ({ key: "course:ml101", shared: true, org }) });

	const acme = forOrg("acme");
	await acme.cache.resolve(ASK, answering("acme 的答案"));

	const globex = forOrg("globex");
	const probe = await globex.cache.resolve(ASK, answering("globex 自己生成的"));
	assert.equal(probe.outcome, "generated", "另一个组织不该命中 acme 那条");
	assert.equal(probe.payload.kind === "answer" && probe.payload.answer, "globex 自己生成的");

	// 各自都能读到自己那条
	const again = await acme.cache.resolve(ASK, answering("不该被调用"));
	assert.equal(again.payload.kind === "answer" && again.payload.answer, "acme 的答案");
});

test("③ 复核候选的 scope —— 存储层 pre-filter 失效时不能把别人的条目复用出去", async () => {
	const inner = createMemoryCacheStore();
	// 一个「坏存储」：searchNearest 无视 scope，把所有条目都返回
	const leaky: CacheStore = {
		...inner,
		async searchNearest(_scope: string, _vector: ReadonlyArray<number>, limit: number): Promise<Array<Candidate>> {
			const all = await inner.all();
			return all.slice(0, limit).map(entry => ({ entry, similarity: 1 }));
		},
	};

	// 先用正常存储给 acme 灌一条
	const acme = harness({ store: leaky, scope: () => ({ key: "course:ml101", shared: true, org: "acme" }) });
	await acme.cache.resolve(ASK, answering("acme 的答案"));

	// globex 问同一句话。② 查不到（scope 不同），③ 会被坏存储喂一条 acme 的条目
	const globex = harness({ store: leaky, scope: () => ({ key: "course:ml101", shared: true, org: "globex" }) });
	const found = await globex.cache.lookup(ASK);

	assert.equal(found.outcome, "miss", "外来 scope 的候选必须被丢掉，不能当命中");
	assert.equal(found.exitedAt, 3);
	const gate3 = found.trace.find(t => t.gate === 3);
	assert.match(String(gate3?.detail), /丢弃 1 条 scope 不符的候选/u, "丢了多少条要如实写进 trace");
});
