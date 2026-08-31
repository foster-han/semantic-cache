/**
 * 把验证台接到 SDK 上。
 *
 * 重构前这里有一套和 SDK 重复的六道闸实现。那种状态下 SDK 等于没被验证过 ——
 * 现在判定逻辑只有一份，跑验证台就是在跑 SDK。
 *
 * 验证台特有的东西留在这里：语料与版本、检索（含章节加权）、答案拼装、匿名化，
 * 以及那几个用来做对照实验的开关。
 */
import {
	compare,
	createMemoryCacheStore,
	createSemanticCache,
	evaluate,
	type CachedPayload,
	type CacheEntry,
	type CachePrompt,
	type Chunk,
	type EvaluationReport,
	type GateTrace,
	type InspectableCacheStore,
	type Scenario,
} from "../sdk/src/index.ts";
import {
	compose,
	COURSE,
	DISTRACTORS,
	DOCS,
	ENTITIES,
	refineSuffix,
	SCENARIOS,
	STUDENT_RECORDS,
	SYL_V2,
} from "./Corpus.ts";
import { cosine, type LabEncoders } from "./Models.ts";
import type { CourseDoc, LabAsk, LabScenario } from "./types/Corpus.ts";
import type { LabConfig, LabCounters } from "./types/LabConfig.ts";

export const DEFAULTS: LabConfig = {
	gate1: false,
	gate4: true,
	gate5: true,
	gate6: true,
	preAnonRetrieval: true,
	declareRedacted: false,
	scopeMode: "course",
	thetaQ: 0.55,
	recallFloor: 0.45,
	thetaAHi: 0.97,
	thetaALo: 0.96,
	topK: 5,
	chunkK: 3,
	chunkCut: 0.85,
	unitBoost: 0.92,
};

export interface AnonymizeResult {
	readonly text: string;
	readonly found: ReadonlyArray<{ token: string; value: string }>;
}

/** 方案 A 的匿名化：按出现顺序编号，两个不同的人都会变成 <PERSON_1>。 */
export function anonymize(text: string): AnonymizeResult {
	let out = text;
	let n = 0;
	const found: Array<{ token: string; value: string }> = [];
	for (const e of ENTITIES) {
		if (out.includes(e)) {
			n += 1;
			found.push({ token: `<PERSON_${n}>`, value: e });
			out = out.split(e).join(`<PERSON_${n}>`);
		}
	}
	return { text: out, found };
}

interface LabChunk extends Chunk {
	readonly title: string;
	readonly version: number;
	readonly unit: string;
}

export interface LabResult {
	readonly answer: string;
	readonly decision: "reuse" | "tune" | "regenerate";
	readonly outcome: string;
	readonly exitedAt: number | null;
	readonly entryId: string | null;
	readonly sourceIds: ReadonlyArray<string>;
	readonly trace: ReadonlyArray<GateTrace>;
	readonly anonymized: string;
	readonly retrievalText: string;
}

export interface LabBenchRow {
	key: string;
	label: string;
	note: string;
	caveat: string | null;
	ok: boolean;
	got: "reuse" | "regenerate";
	primarySource: string | null;
	basedOn: ReadonlyArray<string>;
	expectDoc: string;
	exitedAt: number | null;
}

export interface LabBenchReport {
	rejected?: boolean;
	reason?: string;
	rows: ReadonlyArray<LabBenchRow>;
	total: number;
	falseHit: number;
	missed: number;
}

/**
 * 存储从外面传进来 —— 内存和 pgvector 走的是同一个 `CacheStore` 端口，
 * 验证台不该知道自己接的是哪一种。两种后端跑同一份场景集应当得到同样的数字，
 * 这本身就是一条可验证的断言（见 scripts/compareStores.ts）。
 */
export function createLab(encoder: LabEncoders, store: InspectableCacheStore = createMemoryCacheStore()) {
	let docs: Array<CourseDoc> = DOCS.map(d => ({ ...d }));
	let counters: LabCounters = fresh();

	function fresh(): LabCounters {
		return { ask: 0, exact: 0, reuse: 0, refine: 0, generated: 0 };
	}

	/** 指纹只覆盖这条缓存实际引用过的资料 —— 引用资料级，不是课程级。 */
	function fingerprint(ids: ReadonlyArray<string>): string {
		return ids
			.map(id => {
				const d = docs.find(x => x.id === id);
				return d ? `${d.id}v${d.version}` : `${id}v?`;
			})
			.join(",");
	}

	/**
	 * 课程内检索。章节加权：学生当前学到第几章是产品知道的上下文，
	 * 非当前章节的片段打个折扣。没有这个上下文时「归一化是怎么做的」在两个
	 * 学生那里是完全相同的输入，复用其实是对的 —— 那时它是检索歧义，不是缓存问题。
	 */
	async function retrieveChunks(text: string, unit: string | null, cfg: LabConfig): Promise<Array<LabChunk>> {
		const pool: Array<CourseDoc> = docs.filter(d => d.course === COURSE).map(d => ({ ...d }));
		for (const [name, rec] of Object.entries(STUDENT_RECORDS)) {
			if (text.includes(name)) {
				pool.push({ id: `rec:${name}`, course: COURSE, unit: "个人数据", title: name, version: 1, text: rec });
			}
		}
		if (pool.length === 0) return [];

		const [qv] = await encoder.embedQuery([text]);
		const dv = await encoder.embedPassage(pool.map(d => d.text));
		const ranked = pool
			.map((d, i) => ({
				id: d.id,
				text: d.text,
				title: d.title,
				version: d.version,
				unit: d.unit,
				score: cosine(qv, dv[i]) * (unit && d.unit !== unit && d.unit !== "个人数据" ? cfg.unitBoost : 1),
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, cfg.chunkK);
		const cut = ranked[0].score * cfg.chunkCut;
		return ranked.filter(r => r.score >= cut);
	}


	// kind 是必填的 —— 缺了它 SDK 会把这条当成 plan 处理（sourceIds 落空）。
	// 验证台原来是 .mjs，这个契约变更没在编译期报错，所以踩过一次；转 TS 就是为此。
	const generate = async (_request: CachePrompt, chunks: ReadonlyArray<Chunk>): Promise<CachedPayload> => ({
		kind: "answer",
		answer: compose(chunks as ReadonlyArray<LabChunk>),
		sourceIds: chunks.map(c => c.id),
	});

	const refine = async (
		cachedAnswer: string,
		_request: CachePrompt,
		chunks: ReadonlyArray<Chunk>,
	): Promise<CachedPayload> => ({
		kind: "answer",
		answer: `${cachedAnswer}${refineSuffix((chunks[0] as LabChunk | undefined)?.title ?? "—")}`,
		sourceIds: chunks.map(c => c.id),
	});

	/**
	 * 按一组开关组装一个 SDK 实例。
	 *
	 * 阈值跟着打分器走：`thetaQ` 只属于重排器，关掉 ④ 时它**根本不参与** ——
	 * SDK 已经删掉了"拿 rerankFloor 去卡余弦"那条退化路径。想在无精排时收紧
	 * 问题侧，调 `recallFloor`（那才是余弦尺度）。
	 */
	/**
	 * `storeOverride` 用来把对照实验和场景回放跑在**自己的缓存**上。
	 *
	 * 先前它们和手动探索共用一个 store：点一张实验卡会把手动灌进去的条目全清掉，
	 * 于是「问一句、再问同义的一句」在页面上看起来永远不命中 —— 而实际上是中间
	 * 那一下把种子抹了。清理必须是显式动作，不能是别的操作的副作用。
	 */
	function build(cfg: LabConfig, storeOverride?: InspectableCacheStore) {
		const calibratedOn = `本课程语料，⑥ 用 top-1 算子（scripts/calibrate.ts）`;
		return createSemanticCache({
			recall: {
				scorer: { embedQuestions: t => encoder.embedQuestions(t) },
				thresholds: { floor: cfg.recallFloor },
				calibratedOn,
			},
			support: {
				scorer: { embedQuery: t => encoder.embedQuery(t), embedPassage: t => encoder.embedPassage(t) },
				thresholds: { high: cfg.thetaAHi, low: cfg.thetaALo },
				calibratedOn,
			},
			// 关掉 ④ 就是不传这一段 —— 连同它的阈值一起消失
			rerank:
				cfg.gate4 && encoder.reranker
					? { scorer: encoder.reranker, thresholds: { floor: cfg.thetaQ }, calibratedOn }
					: undefined,
			store: storeOverride ?? store,
			retriever: { retrieve: (text, ctx) => retrieveChunks(text, ctx.unit || null, cfg) },
			// ① PII 门控写在 scope 解析里 —— SDK 不认识 PII，只认 scope 字符串
			scope: prompt => {
				if (cfg.gate1 && prompt.context.pii === "1") {
					return { key: `user:${prompt.context.userId}`, shared: false };
				}
				const key =
					cfg.scopeMode === "unit" ? `course:${COURSE}|unit:${prompt.context.unit || "-"}` : `course:${COURSE}`;
				return { key, shared: true };
			},
			sourceVersion: ids => fingerprint(ids),
			refine,
			gates: { sourceVersion: cfg.gate5, answerCheck: cfg.gate6 },
			recallLimit: cfg.topK,
			ttlMs: null,
		});
	}

	/** 把验证台的一次提问翻译成 SDK 的 CachePrompt。 */
	function toRequest(input: LabAsk, cfg: LabConfig): CachePrompt {
		const anon = anonymize(input.text);
		return {
			matchText: anon.text,
			// **这就是那条硬前提的落点**：SDK 强制你显式选用哪份文本去检索
			retrievalText: cfg.preAnonRetrieval ? input.text : anon.text,
			redacted: cfg.declareRedacted && anon.found.length > 0,
			context: {
				unit: input.unit ?? "",
				userId: input.user ?? "s1",
				pii: anon.found.length > 0 ? "1" : "0",
			},
		};
	}

	/** 在指定的缓存实例上问一次。手动提问和场景回放共用这一份，只是缓存不同。 */
	async function runOn(cache: ReturnType<typeof build>, input: LabAsk, cfg: LabConfig): Promise<LabResult> {
		const prompt = toRequest(input, cfg);
		const result = await cache.resolve(prompt, generate);
		// payload 是唯一读取入口 —— SDK 已经删掉了并排的 answer 字段，
		// 因为 plan 时它是空串，读到空串却不报错正是要消灭的那种失效。
		const answer =
			result.payload.kind === "answer" ? result.payload.answer : `【工具计划】${JSON.stringify(result.payload.plan)}`;
		return {
			answer,
			decision: result.outcome === "generated" ? "regenerate" : result.outcome === "refine" ? "tune" : "reuse",
			outcome: result.outcome,
			exitedAt: result.exitedAt,
			entryId: result.entryId,
			sourceIds: result.sourceIds,
			trace: result.trace,
			anonymized: prompt.matchText,
			retrievalText: prompt.retrievalText,
		};
	}

	async function ask(input: LabAsk, override?: Partial<LabConfig>): Promise<LabResult> {
		const cfg: LabConfig = { ...DEFAULTS, ...override };
		counters.ask += 1;
		const result = await runOn(build(cfg), input, cfg);
		const key = result.outcome as keyof LabCounters;
		if (key in counters) counters[key] += 1;
		return result;
	}

	async function reset(): Promise<void> {
		docs = DOCS.map(d => ({ ...d }));
		await store.clear();
		counters = fresh();
	}

	function bumpCorpus(): string {
		docs = docs.map(d => (d.id === "syl" ? { ...d, version: 2, text: SYL_V2 } : d));
		return fingerprint(["syl"]);
	}

	/**
	 * 场景集回归。判据用 SDK 的 evaluate ——「答案的首要依据是不是那篇资料」，
	 * 不是「有没有复用」。命中另一条内容正确的缓存也算成功。
	 */
	async function bench(override?: Partial<LabConfig>): Promise<LabBenchReport> {
		const cfg: LabConfig = { ...DEFAULTS, ...override };
		// 隔离缓存：跑对照实验不该动到手动探索攒下来的条目
		const isolated = createMemoryCacheStore();
		const cache = build(cfg, isolated);
		const scenarios: Array<Scenario> = SCENARIOS.map((s: LabScenario) => ({
			key: s.key,
			label: s.label,
			expectSourceId: s.expectDoc,
			seed: toRequest(s.seed, cfg),
			probe: toRequest(s.probe, cfg),
			between: s.bumpCorpus ? async () => void bumpCorpus() : undefined,
		}));

		let report: EvaluationReport;
		try {
			report = await evaluate(cache, scenarios, generate, {
				reset: async () => {
					docs = DOCS.map(d => ({ ...d }));
					await isolated.clear();
				},
				warm: async (c, g) => {
					for (const t of DISTRACTORS) await c.resolve(toRequest({ text: t, user: "warm" }, cfg), g);
				},
			});
		} catch (err) {
			docs = DOCS.map(d => ({ ...d }));
			// SDK 拒绝了这个配置 —— 这本身就是有效结果，如实报出来
			return { rejected: true, reason: String(err instanceof Error ? err.message : err), rows: [], total: 0, falseHit: 0, missed: 0 };
		}
		// 只还原语料版本。手动缓存不归这里管
		docs = DOCS.map(d => ({ ...d }));

		const byKey = new Map(SCENARIOS.map(s => [s.key, s]));
		return {
			rows: report.rows.map(r => ({
				key: r.key,
				label: r.label,
				note: byKey.get(r.key)?.note ?? "",
				caveat: byKey.get(r.key)?.caveat ?? null,
				ok: r.ok,
				got: r.outcome === "generated" ? "regenerate" : "reuse",
				primarySource: r.primarySource,
				basedOn: r.actualSourceIds,
				expectDoc: r.expectSourceId,
				exitedAt: r.exitedAt,
			})),
			total: report.total,
			falseHit: report.falseHits,
			missed: report.total - report.passed - report.falseHits,
		};
	}

	/**
	 * 单条场景回放：播种 → （可选改版）→ 探测，全程在自己的缓存里。
	 *
	 * 先前这是浏览器端的四次调用（reset → ask → bump → ask），第一步就把手动
	 * 缓存清了。挪到服务端一次做完，手动那边什么都不会少。
	 */
	async function scenario(key: string, override?: Partial<LabConfig>): Promise<LabResult | null> {
		const sc = SCENARIOS.find(s => s.key === key);
		if (!sc) return null;
		const cfg: LabConfig = { ...DEFAULTS, ...override };
		const isolated = createMemoryCacheStore();
		const cache = build(cfg, isolated);
		const snapshot = docs.map(d => ({ ...d }));
		try {
			await cache.resolve(toRequest(sc.seed, cfg), generate);
			if (sc.bumpCorpus) bumpCorpus();
			return await runOn(cache, sc.probe, cfg);
		} finally {
			docs = snapshot;
		}
	}

	return {
		ask,
		bench,
		scenario,
		reset,
		bumpCorpus,
		defaults: DEFAULTS,
		get docs(): ReadonlyArray<CourseDoc> {
			return docs;
		},
		/** 异步 —— 真库读不出同步结果。内存后端也走同一个签名 */
		cache(): Promise<ReadonlyArray<CacheEntry>> {
			return store.all();
		},
		get counters(): LabCounters {
			return counters;
		},
		async warm(cfg?: Partial<LabConfig>): Promise<number> {
			for (const t of DISTRACTORS) await ask({ text: t, user: "warm" }, cfg);
			return (await store.all()).length;
		},
	};
}

export { compare };
