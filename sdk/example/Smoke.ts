/**
 * 端到端冒烟：用确定性的假模型跑完六道闸，不下载任何东西。
 *
 * 假模型的"向量"是词袋哈希投影 —— 分数没有语义意义，但足以让每道闸真正
 * 被触发一次，验证接线正确。真模型下的行为要用 evaluate() 在你自己的
 * 数据上量。
 */
import { createSemanticCache } from "../src/SemanticCache.ts";
import { createMemoryCacheStore } from "../src/MemoryCacheStore.ts";
import { assertDiscriminates, checkRetrievalEncoder } from "../src/DiscriminationCheck.ts";
import type { PairEncoder, Reranker, RetrievalEncoder } from "../src/types/Encoders.ts";
import type { Chunk, Retriever } from "../src/types/Retrieval.ts";
import type { CachedPayload, CachePrompt } from "../src/types/Pipeline.ts";

function bag(text: string, dim = 128): Array<number> {
	const v = new Array<number>(dim).fill(0);
	const s = text.toLowerCase().replace(/\s+/gu, "");
	for (let i = 0; i < s.length - 1; i++) {
		const g = s.slice(i, i + 2);
		let h = 0;
		for (let k = 0; k < g.length; k++) h = (h * 31 + g.charCodeAt(k)) >>> 0;
		v[h % dim] += 1;
	}
	return v;
}

const pair: PairEncoder = { async embedQuestions(t) { return t.map(x => bag(x)); } };
const retrieval: RetrievalEncoder = {
	async embedQuery(t) { return t.map(x => bag(x)); },
	async embedPassage(t) { return t.map(x => bag(x)); },
};
const rerank: Reranker = {
	async score(q, c) {
		const a = bag(q);
		const b = bag(c);
		let dot = 0, na = 0, nb = 0;
		for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
		return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
	},
};

/* 一门课的资料，syllabus 会被改版 */
const docs = new Map<string, { text: string; version: number }>([
	["syl", { text: "期中考试范围为第一章至第五章，闭卷。", version: 1 }],
	["n5", { text: "过拟合是训练集表现好而验证集变差，模型学进了噪声。", version: 1 }],
	["rec:alice", { text: "Alice 作业二得 82 分，缺少随机种子扣 10 分。", version: 1 }],
	["rec:bob", { text: "Bob 作业二得 95 分，仅报告排版扣 5 分。", version: 1 }],
]);

/** 检索：个人记录只能靠实体名字够到 —— 匿名化后就够不到了 */
const retriever: Retriever = {
	async retrieve(retrievalText) {
		const out: Array<Chunk> = [];
		for (const [id, d] of docs) {
			if (id.startsWith("rec:")) {
				const name = id.slice(4);
				if (retrievalText.toLowerCase().includes(name)) out.push({ id, text: d.text });
				continue;
			}
			out.push({ id, text: d.text });
		}
		const qv = bag(retrievalText);
		return out
			.map(c => {
				const b = bag(c.text);
				let dot = 0, na = 0, nb = 0;
				for (let i = 0; i < qv.length; i++) { dot += qv[i] * b[i]; na += qv[i] ** 2; nb += b[i] ** 2; }
				return { chunk: c, s: dot / (Math.sqrt(na) * Math.sqrt(nb) || 1) };
			})
			.sort((x, y) => y.s - x.s)
			.slice(0, 2)
			.map(x => x.chunk);
	},
};

const store = createMemoryCacheStore();

const cache = createSemanticCache({
	// 阈值跟着打分器走 —— 换打分器就拿不到旧尺度的阈值
	recall: { scorer: pair, thresholds: { floor: 0.3 }, calibratedOn: "假模型词袋，仅供跑通" },
	rerank: { scorer: rerank, thresholds: { floor: 0.3 }, calibratedOn: "假模型词袋，仅供跑通" },
	support: { scorer: retrieval, thresholds: { high: 0.35, low: 0.3 }, calibratedOn: "假模型词袋，仅供跑通" },
	store,
	retriever,
	// PII 门控就写在这里：检出实体 → 个人隔离，否则同课共享
	scope: (prompt: CachePrompt) => (prompt.context.pii === "1" ? `user:${prompt.context.userId}` : "course:ml101"),
	sourceVersion: ids => ids.map(id => `${id}v${docs.get(id)?.version ?? "?"}`).join(","),
	ttlMs: null,
});

const generate = async (_prompt: CachePrompt, chunks: ReadonlyArray<Chunk>): Promise<CachedPayload> => ({
	kind: "answer",
	answer: chunks.length ? `【依据 ${chunks[0].id}】${docs.get(chunks[0].id)?.text ?? ""}` : "（无资料）",
	sourceIds: chunks.map(c => c.id),
});

/** 工具分支：贵的是 LLM 判断该调哪个工具、传什么参数，所以缓存的是**计划**。 */
const planGenerate = async (prompt: CachePrompt): Promise<CachedPayload> => ({
	kind: "plan",
	plan: { tool: "getGrade", assignment: "2", student: "$ENTITY_1" },
});

function ask(matchText: string, retrievalText: string, ctx: Record<string, string> = {}) {
	return cache.resolve({ matchText, retrievalText, context: ctx }, generate);
}

function line(tag: string, r: Awaited<ReturnType<typeof ask>>) {
	const gates = r.trace.map(t => `${t.gate}:${t.verdict}`).join(" ");
	console.log(`${tag.padEnd(26)} ${r.outcome.padEnd(10)} 首要依据 ${String(r.sourceIds[0]).padEnd(11)} | ${gates}`);
}

/* 0. 上线前：判别力自检 */
const report = await checkRetrievalEncoder(retrieval, [
	{ label: "该命中", a: "什么是过拟合", b: docs.get("n5")!.text, shouldMatch: true },
	{ label: "不该命中", a: "什么是过拟合", b: docs.get("syl")!.text, shouldMatch: false },
]);
console.log(`自检 margin=${report.margin.toFixed(4)} usable=${report.usable}`);
assertDiscriminates(report);

console.log("\n--- 灌一条，再问同义 ---");
line("播种 过拟合", await ask("什么是过拟合？", "什么是过拟合？"));
line("② 精确命中", await ask("什么是过拟合？", "什么是过拟合？"));

console.log("\n--- ⑤ 资料改版 ---");
line("播种 期中范围", await ask("期中考试考几章？", "期中考试考几章？"));
docs.set("syl", { text: "期中范围扩大到第一至第九章，改为开卷。", version: 2 });
line("改版后再问", await ask("期中考试考几章？", "期中考试考几章？"));

console.log("\n--- ⑥ 实体塌陷（匿名化后两条字面相同）---");
await store.clear();
line("播种 Alice", await ask("<PERSON_1> 的作业二扣了多少？", "alice 的作业二扣了多少？"));
line("探测 Bob", await ask("<PERSON_1> 的作业二扣了多少？", "bob 的作业二扣了多少？"));

console.log("\n--- 同上，但检索误用匿名化文本（硬前提被破坏）---");
await store.clear();
line("播种 Alice", await ask("<PERSON_1> 的作业二扣了多少？", "alice 的作业二扣了多少？"));
line("探测 Bob", await ask("<PERSON_1> 的作业二扣了多少？", "<PERSON_1> 的作业二扣了多少？"));

console.log("\n--- ① 门控：检出 PII 就个人隔离 ---");
await store.clear();
line("Alice(pii)", await ask("<PERSON_1> 的作业二扣了多少？", "alice 的作业二扣了多少？", { pii: "1", userId: "u1" }));
line("Bob(pii)", await ask("<PERSON_1> 的作业二扣了多少？", "bob 的作业二扣了多少？", { pii: "1", userId: "u2" }));

console.log("\n--- 工具分支：缓存计划而非结果，实体做参数 ---");
await store.clear();
const planCache = createSemanticCache({
	recall: { scorer: pair, thresholds: { floor: 0.3 }, calibratedOn: "假模型词袋，仅供跑通" },
	rerank: { scorer: rerank, thresholds: { floor: 0.3 }, calibratedOn: "假模型词袋，仅供跑通" },
	support: { scorer: retrieval, thresholds: { high: 0.35, low: 0.3 }, calibratedOn: "假模型词袋，仅供跑通" },
	store,
	retriever,
	// 共享 scope，且声明已脱敏 —— 对 plan 来说这正是想要的
	scope: () => ({ key: "course:ml101", shared: true }),
	sourceVersion: () => "-",
	ttlMs: null,
});
for (const who of ["alice", "bob"]) {
	const r = await planCache.resolve(
		{
			matchText: "<PERSON_1> 的作业二得了多少分？",
			retrievalText: `${who} 的作业二得了多少分？`,
			redacted: true,
			context: { userId: who },
		},
		planGenerate,
	);
	const plan = r.payload.kind === "plan" ? JSON.stringify(r.payload.plan) : "(answer)";
	console.log(`${who.padEnd(8)} ${r.outcome.padEnd(10)} plan=${plan} | ${r.trace.map(t => `${t.gate}:${t.verdict}`).join(" ")}`);
}
console.log("→ 两个学生共用同一条 plan 缓存，实体在执行时填参 + 授权。塌陷在这一支是收益不是风险。");

console.log("\n--- 同样配置但缓存的是 answer → SDK 拒绝 ---");
await store.clear();
try {
	await planCache.resolve(
		{ matchText: "<PERSON_1> 的作业二得了多少分？", retrievalText: "alice 的作业二得了多少分？", redacted: true, context: { userId: "alice" } },
		generate,
	);
	console.log("没有拒绝 —— 不变式失效了");
} catch (err) {
	console.log("拒绝:", String((err as Error).message).slice(0, 60), "…");
}

/* ------------------------------------------------------------------ *
 * 拆开用：匹配 / 写入 / 获取 / 失效
 *
 * `resolve` 是这四件事的组合。生成不在库里的时候（外部 LLM 服务、要人工
 * 审核、想先看命中再决定用哪个模型），就自己拼这条路。
 * ------------------------------------------------------------------ */
console.log("\n--- 匹配 / 写入 / 获取 / 失效 ---");
await store.clear();

/* 1. 匹配：空缓存必然 miss，⑥ 还没走到所以 chunks 是 null */
const cold = await cache.lookup({ matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} });
console.log(`lookup(冷)      ${cold.outcome.padEnd(8)} exitedAt=${cold.exitedAt} chunks=${cold.chunks === null ? "null（需自己检索）" : cold.chunks.length}`);

/* 2. 写入：票据来自刚才那次 lookup —— scope 不用再解，向量不用再编 */
const chunks = await retriever.retrieve("什么是过拟合？", {});
const written = await cache.write(
	{ matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} },
	{ kind: "answer", answer: docs.get("n5")!.text, sourceIds: ["n5"] },
	{ ticket: await cold.prepareWrite(), meta: { model: "fake-llm", requestId: "r-1" }, ttlMs: 10 * 60 * 1000 },
);
console.log(
	`write           id=${written.id} scope=${written.scope} 依据=${written.sourceIds.join(",")} ` +
		`meta=${JSON.stringify(written.meta)} 过期=${written.expiresAt === null ? "永不" : "10 分钟后"} 片段=${chunks.length}`,
);

/* 3. 获取：按 id 拿回同一条 */
const got = await cache.get(written.id);
console.log(`get(${written.id})  ${got ? "命中" : "没有"}　matchText=${got?.matchText ?? "-"}`);

/* 4. 再匹配：这次该命中，而且 ⑥ 已经检索过，chunks 可以直接拿去用 */
const warm = await cache.lookup({ matchText: "过拟合是什么意思？", retrievalText: "过拟合是什么意思？", context: {} });
console.log(
	`lookup(热)      ${warm.outcome.padEnd(8)} entryId=${warm.entryId} 支撑度=${warm.support?.toFixed(4) ?? "-"} chunks=${warm.chunks?.length ?? "null"}`,
);

/* 5. 失效：老师改了 n5，这一批立刻失效，不必等 ⑤ 在读时发现 */
const dropped = await cache.invalidateSource("n5");
console.log(`invalidateSource(n5)  删掉 ${dropped} 条　剩余 ${(await store.all()).length} 条`);

/* 6. 批量写入：两次编码灌完 N 条，不是 2N 次 */
const seeded = await cache.writeMany(
	["什么是欠拟合？", "什么是交叉验证？", "L1 和 L2 有什么区别？"].map(q => ({
		prompt: { matchText: q, retrievalText: q, context: {} },
		payload: { kind: "answer" as const, answer: `关于「${q}」的预置答案`, sourceIds: ["n5"] },
		options: { meta: { source: "回填" } },
	})),
);
console.log(`writeMany       灌入 ${seeded.length} 条　共 ${(await store.all()).length} 条`);

/* 7. 批量删除与按 scope 清空 */
await cache.evict(seeded.slice(0, 2).map(e => e.id));
console.log(`evict(2 条)     剩余 ${(await store.all()).length} 条`);
console.log(`clear(course:ml101)  删掉 ${await cache.clear("course:ml101")} 条　剩余 ${(await store.all()).length} 条`);

/* 8. 票据配错 prompt → 当场拒绝，而不是写出一条读不回来的缓存 */
const ticketFor过拟合 = await (await cache.lookup({ matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: {} })).prepareWrite();

for (const [tag, bad] of [
	["文本不一致", { matchText: "什么是欠拟合？", retrievalText: "什么是欠拟合？", context: {} }],
	["scope 不一致", { matchText: "什么是过拟合？", retrievalText: "什么是过拟合？", context: { pii: "1", userId: "alice" } }],
] as const) {
	try {
		await cache.write(bad, { kind: "answer", answer: "x", sourceIds: ["n5"] }, { ticket: ticketFor过拟合 });
		console.log(`${tag.padEnd(14)} 没有拒绝 —— 不变式失效了`);
	} catch (err) {
		console.log(`${tag.padEnd(14)} 拒绝: ${String((err as Error).message).slice(0, 46)}…`);
	}
}
