/**
 * 「这个问题该不该进缓存」——在任何一道闸之前判。
 *
 * 这里测的是三件闸拦不住的事：绕开时**一道闸都不能跑**（否则省不掉开销）、
 * 绕开时**写不进去**（否则下一次就是假命中）、以及策略给的 TTL 要真的落到条目上
 * （否则「短 TTL 而不是完全绕开」这条中间路根本不存在）。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { combinePolicies, createStructuralPolicy, DEFAULT_SEMANTIC_CALL_TYPES } from "../src/CachePolicyRules.ts";
import type { CachePolicy } from "../src/types/CachePolicy.ts";
import { answering, forCosine, harness } from "./Fakes.ts";

const ASK = { matchText: "作业怎么交？", retrievalText: "作业怎么交？", context: {} };
const FOLLOW_UP = { ...ASK, context: { needsHistory: "1" } };

const followUpPolicy: CachePolicy = createStructuralPolicy({
	bypassWhen: { needsHistory: "依赖对话上下文" },
});

test("绕开时一道闸都不跑 —— lookup 侧省掉召回编码与 ⑤⑥", async () => {
	const { cache, counts } = harness({ policy: followUpPolicy });
	const found = await cache.lookup(FOLLOW_UP);
	assert.equal(found.outcome, "bypass");
	assert.equal(found.noCacheReason, "依赖对话上下文");
	assert.equal(found.noStoreReason, "依赖对话上下文");
	assert.deepEqual(found.trace, []);
	assert.equal(found.exitedAt, null);
	// lookup 侧一次编码都没付。**注意这只对 lookup 成立** —— resolve 仍要检索，
	// 不然没有片段可拿去生成。省下的是 ③ 的编码和 ⑤⑥ 的判定，不是「整条链路」。
	assert.equal(counts.questions, 0);
	assert.equal(counts.retrieve, 0);
});

test("绕开时拿不到写入票据 —— 不靠调用方自觉", async () => {
	const { cache } = harness({ policy: followUpPolicy });
	const found = await cache.lookup(FOLLOW_UP);
	await assert.rejects(() => found.prepareWrite(), /判定为不进缓存（依赖对话上下文）/u);
});

test("两个开关都设：照常生成，但一条都不写回", async () => {
	const { cache, store, counts } = harness({ policy: followUpPolicy });
	const result = await cache.resolve(FOLLOW_UP, answering("现学现答", ["n1"], counts));
	assert.equal(result.outcome, "bypassed");
	assert.equal(result.bypassReason, "依赖对话上下文");
	assert.equal(result.payload.kind === "answer" && result.payload.answer, "现学现答");
	// entryId 为 null 的确切含义：生成了，但没有落缓存
	assert.equal(result.entryId, null);
	assert.equal((await store.all()).length, 0);
	assert.equal(counts.generate, 1);

	// 同一个问题再问一次，还是要重新生成 —— 因为上一次根本没存
	await cache.resolve(FOLLOW_UP, answering("现学现答", ["n1"], counts));
	assert.equal(counts.generate, 2);
});

test("没有信号的同一句话照常走缓存 —— 绕开是按信号，不是按文本", async () => {
	const { cache, store } = harness({ policy: followUpPolicy });
	const first = await cache.resolve(ASK, answering("可以在线提交"));
	assert.equal(first.outcome, "generated");
	assert.notEqual(first.entryId, null);
	assert.equal((await store.all()).length, 1);

	const second = await cache.resolve(ASK, answering("不该被调用"));
	assert.equal(second.outcome, "exact");
});

test("策略给的短 TTL 落到条目上 —— 时效性内容不必完全绕开", async () => {
	const policy = createStructuralPolicy({ shortTtlWhen: { timeSensitive: 600_000 } });
	const now = () => 1_000_000;
	// 第二个问题要给一个远离 BASE 的向量，否则它会命中第一条缓存而根本不写入
	const { cache, store } = harness({ policy, now, ttlMs: null, pair: { "什么是过拟合？": forCosine(0.1) } });

	await cache.resolve({ ...ASK, context: { timeSensitive: "1" } }, answering("本周五截止"));
	const [entry] = await store.all();
	assert.equal(entry.expiresAt, 1_000_000 + 600_000);

	// 没有这个信号的条目仍然走全局默认（这套 harness 里是「不过期」）
	await cache.resolve({ matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} }, answering("模型记住了噪声"));
	const stable = (await store.all()).find(e => e.matchText === "什么是过拟合？");
	assert.equal(stable?.expiresAt, null);
});

test("写入时显式给的 ttlMs 压过策略的 —— 策略是默认值，不是命令", async () => {
	const policy = createStructuralPolicy({ shortTtlWhen: { timeSensitive: 600_000 } });
	const now = () => 1_000_000;
	const { cache, store } = harness({ policy, now, ttlMs: null });
	const prompt = { ...ASK, context: { timeSensitive: "1" } };
	const found = await cache.lookup(prompt);
	await cache.write(prompt, { kind: "answer", answer: "本周五截止", sourceIds: ["n1"] }, {
		ticket: await found.prepareWrite(),
		ttlMs: 5_000,
	});
	const [entry] = await store.all();
	assert.equal(entry.expiresAt, 1_005_000);
});

test("falsy 值不算信号 —— context 是字符串，'0'/'false' 必须当成没设", async () => {
	const { cache } = harness({ policy: followUpPolicy });
	for (const value of ["", "0", "false", "no", "off", " FALSE "]) {
		const found = await cache.lookup({ ...ASK, context: { needsHistory: value } });
		assert.notEqual(found.outcome, "bypass", `context 值 ${JSON.stringify(value)} 不该触发绕开`);
	}
	const set = await cache.lookup({ ...ASK, context: { needsHistory: "yes" } });
	assert.equal(set.outcome, "bypass");
});

test("同一个键既绕开又限时、TTL 非正数：两个都在构造期抛", () => {
	assert.throws(
		() => createStructuralPolicy({ bypassWhen: { x: "理由" }, shortTtlWhen: { x: 1000 } }),
		/同时出现在 bypassWhen 和 shortTtlWhen/u,
	);
	assert.throws(() => createStructuralPolicy({ shortTtlWhen: { x: 0 } }), /不是正的毫秒数/u);
	assert.throws(() => createStructuralPolicy({ shortTtlWhen: { x: -5 } }), /不是正的毫秒数/u);
});

test("combinePolicies：第一个说绕开的赢，都放行则取最短的 TTL", async () => {
	const short = createStructuralPolicy({ shortTtlWhen: { a: 10_000 } });
	const long = createStructuralPolicy({ shortTtlWhen: { a: 60_000 } });
	const veto = createStructuralPolicy({ bypassWhen: { stop: "有副作用" } });

	const merged = combinePolicies(long, short, veto);
	assert.deepEqual(await merged({ ...ASK, context: { a: "1" } }), { ttlMs: 10_000 });
	assert.deepEqual(await merged({ ...ASK, context: {} }), {});

	const stopped = await merged({ ...ASK, context: { a: "1", stop: "1" } });
	assert.equal(stopped.noCache, "有副作用");
	assert.equal(stopped.noStore, "有副作用");

	assert.throws(() => combinePolicies(), /至少要一个策略/u);
});

test("不给 policy 就是全都可以缓存 —— 这一层是可选的", async () => {
	const { cache, store } = harness();
	await cache.resolve(FOLLOW_UP, answering("照常缓存"));
	assert.equal((await store.all()).length, 1);
});

test("prepareTicket 也要查策略 —— 否则它就是绕过守卫的后门", async () => {
	const { cache } = harness({ policy: followUpPolicy });
	await assert.rejects(() => cache.prepareTicket(FOLLOW_UP), /判定为不进缓存（依赖对话上下文）/u);
	// 放行的 prompt 照常发票，并带上策略的 TTL
	const ttlPolicy = createStructuralPolicy({ shortTtlWhen: { timeSensitive: 600_000 } });
	const other = harness({ policy: ttlPolicy });
	const ticket = await other.cache.prepareTicket({ ...ASK, context: { timeSensitive: "1" } });
	assert.equal(ticket.ttlMs, 600_000);
});

test("只设 noCache =「重新回答」：不查、强制重生成、写回并替换掉旧的那条", async () => {
	const policy = createStructuralPolicy({ noCacheWhen: { regenerate: "学生要求重新回答" } });
	const { cache, store, counts } = harness({ policy });

	// 先正常灌一条
	await cache.resolve(ASK, answering("简略版", ["n1"], counts));
	const [before] = await store.all();
	assert.equal(before.answer, "简略版");

	// 点「重新回答」：key 不变，只多一个标志位
	const again = await cache.resolve({ ...ASK, context: { regenerate: "1" } }, answering("详细版", ["n1"], counts));
	assert.equal(again.outcome, "bypassed");
	assert.equal(counts.generate, 2, "必须真的重新生成，不能返回缓存里那条");

	// 新答案写回去了，而且旧那条被替换掉 —— 不是并存
	const after = await store.all();
	assert.equal(after.length, 1);
	assert.equal(after[0].answer, "详细版");

	// 下一个学生直接命中改进后的版本
	const next = await cache.resolve(ASK, answering("不该被调用", ["n1"], counts));
	assert.equal(next.outcome, "exact");
	assert.equal(next.payload.kind === "answer" && next.payload.answer, "详细版");
	assert.equal(counts.generate, 2);
});

test("只设 noStore =「出五道练习题」：照常读得到别人的，但自己这份不存", async () => {
	const policy = createStructuralPolicy({ noStoreWhen: { openEnded: "开放生成，没有唯一答案" } });
	const { cache, store, counts } = harness({ policy });
	const prompt = { ...ASK, context: { openEnded: "1" } };

	// 没有缓存时：生成，但不写
	const first = await cache.resolve(prompt, answering("第一份练习题", ["n1"], counts));
	assert.equal(first.outcome, "generated", "读路径照常跑完了闸，这不是 bypass");
	assert.equal(first.entryId, null);
	assert.equal((await store.all()).length, 0);

	// 票据是拒发的 —— 想绕过 resolve 自己写也写不进去
	const found = await cache.lookup(prompt);
	assert.equal(found.noStoreReason, "开放生成，没有唯一答案");
	assert.equal(found.noCacheReason, null, "noStore 不该顺手把读也关掉");
	await assert.rejects(() => found.prepareWrite(), /判定为不进缓存（开放生成，没有唯一答案）/u);

	// 但读是通的：换一个没有该标志的请求把条目灌进去，带标志的请求照样命中
	await cache.resolve(ASK, answering("别人存下的练习题", ["n1"], counts));
	const reused = await cache.resolve(prompt, answering("不该被调用", ["n1"], counts));
	assert.equal(reused.outcome, "exact");
	assert.equal(reused.payload.kind === "answer" && reused.payload.answer, "别人存下的练习题");
});

test("调用类型白名单：确定性输出的那几类默认不走语义缓存", async () => {
	const policy = createStructuralPolicy();
	for (const callType of ["embedding", "rerank", "transcription", "text_completion"]) {
		const d = await policy({ ...ASK, context: { callType } });
		assert.equal(d.noCache, d.noStore, `${callType} 该读写一起拦`);
		assert.match(String(d.noCache), /不在语义缓存白名单里/u, `${callType} 该被拦下`);
	}
	for (const callType of DEFAULT_SEMANTIC_CALL_TYPES) {
		const d = await policy({ ...ASK, context: { callType } });
		assert.deepEqual(d, {}, `${callType} 该放行`);
	}
});

test("异步变体自动认，但 anthropic_messages 自己以 a 开头 —— 不能无脑剥前缀", async () => {
	const policy = createStructuralPolicy();
	// 剥前缀能认出来的
	assert.deepEqual(await policy({ ...ASK, context: { callType: "acompletion" } }), {});
	assert.deepEqual(await policy({ ...ASK, context: { callType: "aresponses" } }), {});
	// 原名就以 a 开头：两种写法都要认
	assert.deepEqual(await policy({ ...ASK, context: { callType: "anthropic_messages" } }), {});
	assert.deepEqual(await policy({ ...ASK, context: { callType: "aanthropic_messages" } }), {});
	// 异步的排除项照样排除
	const embedded = await policy({ ...ASK, context: { callType: "aembedding" } });
	assert.match(String(embedded.noStore), /不在语义缓存白名单里/u);
});

test("没标调用类型默认放行；requireCallType 打开后不放行", async () => {
	assert.deepEqual(await createStructuralPolicy()(ASK), {});

	const strict = createStructuralPolicy({ requireCallType: true });
	const d = await strict(ASK);
	assert.match(String(d.noCache), /没有标注调用类型（context\.callType）/u);
	assert.equal(d.noCache, d.noStore);
	// 标了就照常判
	assert.deepEqual(await strict({ ...ASK, context: { callType: "completion" } }), {});
});

test("白名单和键名都可配；空白名单在构造期抛", async () => {
	const policy = createStructuralPolicy({
		callTypeKey: "kind",
		allowedCallTypes: ["completion", "embedding"],
	});
	assert.deepEqual(await policy({ ...ASK, context: { kind: "embedding" } }), {}, "显式放行的就该放行");
	const reranked = await policy({ ...ASK, context: { kind: "rerank" } });
	assert.match(String(reranked.noCache), /"rerank" 不在语义缓存白名单里/u);
	// 默认键名不再生效
	assert.deepEqual(await policy({ ...ASK, context: { callType: "rerank" } }), {}, "换了键名后旧键不该被读");

	assert.throws(() => createStructuralPolicy({ allowedCallTypes: [] }), /等于关掉整个缓存/u);
});

test("白名单拒绝的请求，lookup 一道闸都不跑,理由进得了看板", async () => {
	const { cache, counts } = harness({ policy: createStructuralPolicy() });
	const found = await cache.lookup({ ...ASK, context: { callType: "embedding" } });
	assert.equal(found.outcome, "bypass");
	assert.equal(counts.questions, 0);
	await assert.rejects(() => found.prepareWrite(), /判定为不进缓存/u);

	const result = await cache.resolve({ ...ASK, context: { callType: "embedding" } }, answering("向量", ["n1"], counts));
	assert.equal(result.outcome, "bypassed");
	assert.match(String(result.bypassReason), /"embedding" 不在语义缓存白名单里/u);
});
