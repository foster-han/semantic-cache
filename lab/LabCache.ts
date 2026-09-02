/**
 * 把验证台接到 SDK 上。
 *
 * 重构前这里有一套和 SDK 重复的闸实现。那种状态下 SDK 等于没被验证过 ——
 * 现在判定逻辑只有一份，跑验证台就是在跑 SDK。
 *
 * 验证台特有的东西留在这里：语料与版本、检索（含章节加权）、答案拼装、匿名化，
 * 以及那几个用来做对照实验的开关。
 */
import {
	compare,
	composeScope,
	createMemoryCacheStore,
	createMetrics,
	createSemanticCache,
	evaluate,
	type CachedPayload,
	type CacheEntry,
	type CachePrompt,
	type CacheResult,
	type Chunk,
	type EvaluationReport,
	type GateTrace,
	type InspectableCacheStore,
	type Scenario,
	type ScopeDecision,
} from "../sdk/src/index.ts";
import { COURSE, DISTRACTORS, DOCS, ENTITIES, LANGUAGE, SCENARIOS, STUDENT_RECORDS, SYL_V2 } from "./Corpus.ts";
import { resolveCalibration, type ActiveCalibration } from "./Calibrations.ts";
import { createGenerator, type LabGenerator } from "./Generators.ts";
import { cosine, type LabEncoders } from "./Models.ts";
import type { CourseDoc, LabAsk, LabScenario } from "./types/Corpus.ts";
import type { LabConfig, LabCounters } from "./types/LabConfig.ts";

/**
 * 与标定无关的那部分默认值。**四个阈值和 ④ 的开关不在这里** —— 它们由
 * `Calibrations.ts` 按 (语料 × 编码器 × 生成端) 给出，见 `defaultsFor()`。
 */
export const BASE_DEFAULTS = {
	gate1: false,
	preAnonRetrieval: true,
	declareRedacted: false,
	scopeMode: "course",
	topK: 5,
	chunkK: 3,
	chunkCut: 0.85,
	unitBoost: 0.92,
} as const satisfies Omit<LabConfig, "gate4" | "thetaQ" | "recallFloor">;

/**
 * 把标定表那一行合成一份完整默认配置。
 *
 * **④ 的默认开关跟着 `thetaQ` 走**：没有标定过的闸值就没有这道闸，开着它只会得到
 * 一道恒放行的假闸 —— 那比关着更糟，因为页面上看起来它在工作。
 */
export function defaultsFor(calibration: ActiveCalibration): LabConfig {
	return {
		...BASE_DEFAULTS,
		gate4: calibration.thetaQ !== null,
		thetaQ: calibration.thetaQ,
		recallFloor: calibration.recallFloor,
	};
}

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
	/** SDK 原始返回 —— 指标累加器要吃它，验证台自己的字段是给页面看的 */
	readonly raw: CacheResult;
	readonly answer: string;
	readonly decision: "reuse" | "regenerate";
	readonly outcome: string;
	readonly exitedAt: number | null;
	readonly entryId: string | null;
	/** 答案来自哪个 space —— 条目唯一记下来的「依据」，也是清缓存的单位 */
	readonly space: string;
	readonly trace: ReadonlyArray<GateTrace>;
	readonly anonymized: string;
	readonly retrievalText: string;
}

/** 「已移交」的场景在它该归属的那个配置下跑出来的结果 */
export interface LabCoveredUnder {
	/** 那个配置怎么描述，直接给页面显示 */
	readonly config: string;
	readonly ok: boolean;
	readonly got: "reuse" | "regenerate";
	readonly space: string;
	readonly exitedAt: number | null;
}

/**
 * 单条场景回放的结果。`handedTo` 非 null = 这条测的是一道已经移除的闸，
 * 那一栏是它在「现在谁负责」那个配置下跑出来的结果。
 */
export type LabScenarioResult = LabResult & {
	readonly handedTo:
		| null
		| { readonly config: string; readonly rejected: string }
		| {
				readonly config: string;
				readonly decision: "reuse" | "regenerate";
				readonly outcome: string;
				readonly space: string;
				readonly exitedAt: number | null;
		  };
};

export interface LabBenchRow {
	/**
	 * 复用了缓存，但答案来自另一个 space。判据来自 SDK 的 `evaluate`。
	 *
	 * **它以前更细**：条目记着自己引了哪些文档，这一栏问的是「首要依据是不是那篇资料」。
	 * 那个维度已经移除，判据只剩 space；而 scope 隔离在 ① 就挡住了、③ 还复核一遍，
	 * 所以跨 space 的复用在正常配置下根本发生不了 —— 这一栏于是**几乎恒为 0**，
	 * 它现在能抓的是 scope 路由错了，抓不到检索精度错了。
	 */
	falseHit: boolean;
	key: string;
	label: string;
	note: string;
	caveat: string | null;
	/** 非 null = 这条测的是一道已经移除的闸，不算失败 */
	nowHandledBy: "user-scope" | "unit-scope" | null;
	/** 在 `nowHandledBy` 指的那个配置下再跑一遍的结果 */
	coveredUnder: LabCoveredUnder | null;
	ok: boolean;
	got: "reuse" | "regenerate";
	/** 答案实际来自哪个 space */
	space: string;
	/** 该来自哪个 space —— 取播种那一问解析出来的 scope */
	expectSpace: string;
	exitedAt: number | null;
}

export interface LabBenchReport {
	rejected?: boolean;
	reason?: string;
	rows: ReadonlyArray<LabBenchRow>;
	total: number;
	falseHit: number;
	missed: number;
	/**
	 * 「已移交」的条数：先前由 ⑥ 拦下、⑥ 移除后改由隔离边界负责的那些。
	 *
	 * **它们不计入 `falseHit`。** 在当前配置下它们多半确实命中了，但那不是回归 ——
	 * 那道闸是被有意拿掉的，代价写在 DESIGN 的「诚实的边界」里。把它们混进假命中，
	 * 一次设计取舍会永远表现成一批查不出原因的失败。
	 */
	movedOut: number;
}

/**
 * 存储从外面传进来 —— 内存和 pgvector 走的是同一个 `CacheStore` 接口，
 * 验证台不该知道自己接的是哪一种。两种后端跑同一份场景集应当得到同样的数字，
 * 这本身就是一条可验证的断言（见 scripts/compareStores.ts）。
 */
export function createLab(
	encoder: LabEncoders,
	store: InspectableCacheStore = createMemoryCacheStore(),
	generator: LabGenerator = createGenerator(),
) {
	let docs: Array<CourseDoc> = DOCS.map(d => ({ ...d }));
	let counters: LabCounters = fresh();
	/** 手动提问的运行指标。对齐 Redis LangCache 看板那一组，再加五道闸的分布 */
	const metrics = createMetrics({ latencySamples: 512 });
	/**
	 * 这一次运行该用哪组阈值，由 (语料 × 编码器 × 生成端) 决定 —— 三者都是运行期才
	 * 知道的，所以标定不能是模块常量。`calibration` 同时带着每个 stage 各自的
	 * `calibratedOn`，页面和 trace 上看到的就是「这个数是在什么上标出来的」。
	 */
	const calibration = resolveCalibration({
		corpus: LANGUAGE,
		encoders: encoder.mode,
		generator: generator.kind,
		// ④ 的 θq 属于 (重排模型 × 形态)，所以这两个也得递进去 —— 见 Calibrations.ts 的 RERANK_CALIBRATIONS
		rerankModel: encoder.reranker ? encoder.models.rerank : null,
		rerankTarget: encoder.models.rerankTarget,
	});
	const defaults = defaultsFor(calibration);

	function fresh(): LabCounters {
		return { ask: 0, exact: 0, reuse: 0, generated: 0 };
	}

	/**
	 * 课程内检索。章节加权：学生当前学到第几章是产品知道的上下文，
	 * 非当前章节的片段打个折扣。没有这个上下文时「归一化是怎么做的」在两个
	 * 学生那里是完全相同的输入，复用其实是对的 —— 那时它是检索歧义，不是缓存问题。
	 */
	/**
	 * 资料向量缓存。**键是 `id + version`，所以「语料改版」自动失效，不用手工清。**
	 *
	 * 先前每次检索都把整份语料重新编码一遍。实测：一次未命中的 ask 约 2400ms，
	 * 其中 embedPassage×27 占 1257ms（52%），而生成只占 845ms —— 也就是说
	 * 「真生成太慢」这个印象里有一半根本不是生成的锅。一次完整 bench（416 次）
	 * 因此白白多花约 8.7 分钟。
	 *
	 * 真实 RAG 应用不会这么干，那正是向量索引存在的意义；验证台这里图省事，
	 * 结果把自己的实现开销算到了被测对象头上。
	 */
	const passageCache = new Map<string, ReadonlyArray<number>>();

	async function passageVectors(pool: ReadonlyArray<CourseDoc>): Promise<Array<ReadonlyArray<number>>> {
		const missing = pool.filter(d => !passageCache.has(`${d.id}v${d.version}`));
		if (missing.length > 0) {
			const fresh = await encoder.embedPassage(missing.map(d => d.text));
			missing.forEach((d, i) => passageCache.set(`${d.id}v${d.version}`, fresh[i]));
		}
		return pool.map(d => passageCache.get(`${d.id}v${d.version}`) as ReadonlyArray<number>);
	}

	async function retrieveChunks(text: string, unit: string | null, cfg: LabConfig): Promise<Array<LabChunk>> {
		const pool: Array<CourseDoc> = docs.filter(d => d.course === COURSE).map(d => ({ ...d }));
		for (const [name, rec] of Object.entries(STUDENT_RECORDS)) {
			if (text.includes(name)) {
				pool.push({ id: `rec:${name}`, course: COURSE, unit: "个人数据", title: name, version: 1, text: rec });
			}
		}
		if (pool.length === 0) return [];

		const [qv] = await encoder.embedQuery([text]);
		const dv = await passageVectors(pool);
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
		/**
		 * 截断线取「最高分的 chunkCut 倍」。
		 *
		 * **最高分为负时这个公式会反过来**（`-0.1 * 0.85 = -0.085 > -0.1`），连 top-1
		 * 自己都被筛掉，返回空片段。这里把它写成明确的决定，不留成意外：余弦全负
		 * 说明这个问题跟整个语料都不沾边，那时**返回空比硬留 top-1 更安全**。
		 * 生成端拿到空片段会走「没有资料」那条兜底，而那种答案 `cacheable()` 拒绝写入；
		 * 硬留一条不相关的 top-1 反而会让它据此写出一条有依据、内容却不相干的缓存。
		 */
		if (ranked[0].score <= 0) return [];
		const cut = ranked[0].score * cfg.chunkCut;
		return ranked.filter(r => r.score >= cut);
	}


	// kind 是必填的 —— 缺了它 SDK 会把这条当成 plan 处理（答案落空）。
	// 验证台原来是 .mjs，这个契约变更没在编译期报错，所以踩过一次；转 TS 就是为此。
	// 生成端是可切换的接口（GEN=stub / claude-cli）。stub 是换序换壳，不是真生成 ——
	// CE_TARGET=answer 下 ④ 的 candidate 就是这个答案，所以 θq 的绝对值在它上面标不准。
	// 见 Generators.ts。
	const generate = (prompt: CachePrompt, chunks: ReadonlyArray<Chunk>): Promise<CachedPayload> =>
		generator.generate(prompt, chunks);

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
	/**
	 * bench 与场景回放用的生成端就是 `generator` 本身。
	 *
	 * **先前这里又套了一层记忆化**（一个私有的 benchGenerator 包装），于是默认配置下
	 * bench 是双层：`createGenerator()` 里那层带失败剔除与 2000 条上限，外面这层无条件
	 * 存 promise、既不剔除失败也没有上限 —— 内层「一次网络抖动会把这个 key 永久钉死在
	 * 错误上」的防护被外层撤销了。去重与 `GEN_MEMO` 的决定现在只在
	 * `createGenerator()` 里做一次。
	 */

	function build(cfg: LabConfig, storeOverride?: InspectableCacheStore, genOverride?: LabGenerator) {
		/**
		 * **三个 stage 的 `calibratedOn` 各不相同。** 先前它们共用一句
		 * 「本课程语料，⑥ 用 top-1 算子」，而 ④ 的闸值根本不是那个脚本标出来的 ——
		 * 这个必填字段的全部意义就是防止阈值离开标定语境，填一句放之四海皆准的话
		 * 等于把它作废。
		 */
		if (cfg.gate4 && encoder.reranker && cfg.thetaQ === null) {
			throw new Error(
				`④ 打开了，但当前组合（${LANGUAGE} × ${encoder.models.rerank ?? "无重排器"} × ` +
					`${calibration.rerankTarget === "answer" ? "问↔答" : "问↔问"}）没有标定过的 θq。${calibration.rerankNote}。` +
					"出路：跑 lab/_probe_ce6.ts 量一下这个 (模型 × 形态) 分不分得开，分得开就补一行到 RERANK_CALIBRATIONS；" +
					"中文上已知可用的组合是 CE_MODEL=Xenova/bge-reranker-base CE_TARGET=answer。或显式 THETA_Q= 一个值（那就由你自己为它负责）。",
			);
		}
		return createSemanticCache({
			recall: {
				scorer: { embedQuestions: t => encoder.embedQuestions(t) },
				thresholds: { floor: cfg.recallFloor },
				calibratedOn: calibration.recallNote,
			},
			// 关掉 ④ 就是不传这一段 —— 连同它的阈值一起消失
			rerank:
				cfg.gate4 && encoder.reranker && cfg.thetaQ !== null
					? {
							scorer: encoder.reranker,
							// target 和 floor 捆在一起：换形态就是换尺度，θq 不通用
							thresholds: { floor: cfg.thetaQ, target: calibration.rerankTarget },
							calibratedOn: calibration.rerankNote,
						}
					: undefined,
			store: storeOverride ?? store,
			retriever: { retrieve: (text, ctx) => retrieveChunks(text, ctx.unit || null, cfg) },
			scope: prompt => scopeOf(prompt, cfg),
			recallLimit: cfg.topK,
			ttlMs: null,
		});
	}

	/**
	 * ① PII 门控写在 scope 解析里 —— SDK 不认识 PII，只认 scope 字符串。
	 *
	 * **抽成命名函数，是因为 space 现在是判据。** 场景的期望值要算出「播种那一问落在
	 * 哪个 space」，而那必须和 SDK 真正用的是同一个函数 —— 复制一份出来算，就是把
	 * 「标定与实现同算子」这条规矩在 scope 上再破一次。
	 */
	function scopeOf(prompt: CachePrompt, cfg: LabConfig): ScopeDecision {
		// 验证台是单租户，但 org 仍要显式给 —— 让它是个决定，不是一个遗漏
		const org = "lab";
		if (cfg.gate1 && prompt.context.pii === "1") {
			return { key: `user:${prompt.context.userId}`, shared: false, org };
		}
		const key = cfg.scopeMode === "unit" ? `course:${COURSE}|unit:${prompt.context.unit || "-"}` : `course:${COURSE}`;
		return { key, shared: true, org };
	}

	/** 一次提问落在哪个 space，拼法与 SDK 存进条目的完全一致。 */
	function spaceOf(input: LabAsk, cfg: LabConfig): string {
		const decision = scopeOf(toRequest(input, cfg), cfg);
		return composeScope(decision.org, decision.key);
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
	async function runOn(
		cache: ReturnType<typeof build>,
		input: LabAsk,
		cfg: LabConfig,
		gen: LabGenerator = generator,
	): Promise<LabResult> {
		const prompt = toRequest(input, cfg);
		const result = await cache.resolve(prompt, (p, c) => gen.generate(p, c));
		// payload 是唯一读取入口 —— SDK 已经删掉了并排的 answer 字段，
		// 因为 plan 时它是空串，读到空串却不报错正是要消灭的那种失效。
		const answer =
			result.payload.kind === "answer" ? result.payload.answer : `【工具计划】${JSON.stringify(result.payload.plan)}`;
		return {
			answer,
			decision: result.outcome === "generated" ? "regenerate" : "reuse",
			outcome: result.outcome,
			exitedAt: result.exitedAt,
			entryId: result.entryId,
			space: result.scope,
			trace: result.trace,
			anonymized: prompt.matchText,
			retrievalText: prompt.retrievalText,
			raw: result,
		};
	}

	async function ask(input: LabAsk, override?: Partial<LabConfig>): Promise<LabResult> {
		const cfg: LabConfig = { ...defaults, ...override };
		counters.ask += 1;
		const started = Date.now();
		const result = await runOn(build(cfg), input, cfg);
		const key = result.outcome as keyof LabCounters;
		if (key in counters) counters[key] += 1;
		/**
		 * 只有**手动提问**进指标，对照实验和场景回放不进。
		 *
		 * 那两个是离线跑标注集，一次点击就灌进几百条构造流量 —— 混进来的话看板上的
		 * 命中率就变成「场景集的构成比例」，而不是「真实提问的命中情况」。
		 * 这跟缓存本身要隔离是同一个道理。
		 */
		metrics.record({
			result: result.raw,
			ms: Date.now() - started,
			segment: result.raw.trace[0]?.detail.match(/scope = ([^（(]+)/)?.[1]?.trim(),
		});
		return result;
	}

	async function reset(): Promise<void> {
		docs = DOCS.map(d => ({ ...d }));
		await store.clear();
		counters = fresh();
	}

	function bumpCorpus(): string {
		docs = docs.map(d => (d.id === "syl" ? { ...d, version: 2, text: SYL_V2 } : d));
		return docs.find(d => d.id === "syl")?.title ?? "syl";
	}

	/**
	 * 「资料改版」在场景里怎么演：**改版 + 清掉那个 space**。
	 *
	 * 先前只要改版就够了 —— ⑤ 会在读时比出版本不符然后踢掉条目。⑤ 已经移除，读侧
	 * 再没有任何一道闸看得见改版，所以场景必须把新机制照实跑出来：内容单元是 space，
	 * 改了就清那一片。少了这一步，这两条场景测的是一道不存在的闸，而且会静静地通过。
	 */
	function revise(cache: ReturnType<typeof build>, sc: LabScenario, cfg: LabConfig): Promise<void> {
		bumpCorpus();
		const decision = scopeOf(toRequest(sc.seed, cfg), cfg);
		return cache.clear({ org: decision.org, key: decision.key }).then(() => undefined);
	}

	/**
	 * 场景集回归。判据用 SDK 的 evaluate ——「答案来自哪个 space」，不是「有没有复用」。
	 * 命中另一条内容正确的缓存也算成功。
	 */
	/**
	 * 「已移交」的场景该在哪个配置下被拦下。
	 *
	 * ⑥ 移除时的取舍是「代价由隔离边界和缓存键的构成来付」—— 这张表把那句话变成
	 * 可执行的：每条移交出去的场景都指名一个配置，回放时真的按它再跑一遍。
	 * 拦不住的话页面上会直接看见，那说明取舍不成立，而不是「文档里那么说的」。
	 */
	const COVERAGE: Readonly<Record<"user-scope" | "unit-scope", { config: string; override: Partial<LabConfig> }>> = {
		"user-scope": { config: "① 检出实体 → user scope（gate1 开）", override: { gate1: true } },
		"unit-scope": { config: "scope 带上章节（scopeMode: unit）", override: { scopeMode: "unit" } },
	};

	async function bench(override?: Partial<LabConfig>, storeOverride?: InspectableCacheStore): Promise<LabBenchReport> {
		const cfg: LabConfig = { ...defaults, ...override };
		/**
		 * 默认跑在一个一次性的内存缓存上 —— 点一次对照实验不该动到手动探索攒下来的条目。
		 *
		 * `storeOverride` 是留给 `compareStores.ts` 的：那个脚本的全部意义就是让同一份
		 * 场景集**真的落到真库上**。不传的话它比的是内存跟内存，
		 * 「换存储不改判定」就成了一句空话，而且空得看不出来——两列数字永远一致。
		 */
		const isolated = storeOverride ?? createMemoryCacheStore();
		let report: EvaluationReport;
		try {
			// **`build()` 也要在 try 里。** 它会拒绝一些配置（脱敏 × 共享 scope、
			// ④ 开着却没有标定过的 θq），而「这个配置不成立」正是对照实验的有效结果之一 ——
			// 先前 build 在 try 外面，于是它一抛错整个请求变成 500，页面上看到的是
			// 「请求失败」而不是「配置 B 被拒绝，原因是……」。
			const cache = build(cfg, isolated);
			const scenarios: Array<Scenario> = SCENARIOS.map((s: LabScenario) => ({
				key: s.key,
				label: s.label,
				// 判据是「答案该来自播种那条所在的 space」—— 移交出去的那几条在移交后的配置下
				// 会落到另一个 space，那正是移交要的效果，所以它们不计入下面的统计。
				expectSpace: spaceOf(s.seed, cfg),
				seed: toRequest(s.seed, cfg),
				probe: toRequest(s.probe, cfg),
				between: s.bumpCorpus ? () => revise(cache, s, cfg) : undefined,
			}));
			report = await evaluate(cache, scenarios, (p, c) => generator.generate(p, c), {
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
			await isolated.clear();
			// SDK 拒绝了这个配置 —— 这本身就是有效结果，如实报出来
			return { rejected: true, reason: String(err instanceof Error ? err.message : err), rows: [], total: 0, falseHit: 0, missed: 0, movedOut: 0 };
		}
		// 只还原语料版本。手动缓存不归这里管
		docs = DOCS.map(d => ({ ...d }));
		// 跑完不留状态。一次性内存缓存随手就丢，这一步是为传了真库的那种情况
		await isolated.clear();

		const byKey = new Map(SCENARIOS.map(s => [s.key, s]));

		/**
		 * 「已移交」的那些，再按它该归属的配置跑一遍。
		 *
		 * 按配置分组一次跑完，而不是一条一条建缓存：同一个 override 下的几条本来就
		 * 共享一份配置，分开跑只是多建几次缓存。跑不起来（比如那个配置被 SDK 拒了）
		 * 不该让整份报告失败 —— 那一列留空，主结果照常出。
		 */
		const covered = new Map<string, LabCoveredUnder>();
		const moved = SCENARIOS.filter(s => s.nowHandledBy !== undefined);
		for (const mode of ["user-scope", "unit-scope"] as const) {
			const group = moved.filter(s => s.nowHandledBy === mode);
			if (group.length === 0) continue;
			const alt: LabConfig = { ...cfg, ...COVERAGE[mode].override };
			const altStore = createMemoryCacheStore();
			try {
				const altCache = build(alt, altStore);
				const altReport = await evaluate(
					altCache,
					group.map((s: LabScenario) => ({
						key: s.key,
						label: s.label,
						expectSpace: spaceOf(s.seed, alt),
						seed: toRequest(s.seed, alt),
						probe: toRequest(s.probe, alt),
						between: s.bumpCorpus ? () => revise(altCache, s, alt) : undefined,
					})),
					(p, c) => generator.generate(p, c),
					{
						reset: async () => {
							docs = DOCS.map(d => ({ ...d }));
							await altStore.clear();
						},
						warm: async (c, g) => {
							for (const t of DISTRACTORS) await c.resolve(toRequest({ text: t, user: "warm" }, alt), g);
						},
					},
				);
				for (const r of altReport.rows) {
					covered.set(r.key, {
						config: COVERAGE[mode].config,
						ok: r.ok,
						got: r.outcome === "generated" ? "regenerate" : "reuse",
						space: r.actualSpace,
						exitedAt: r.exitedAt,
					});
				}
			} catch {
				// 那个配置本身被拒（例如脱敏 × 共享 scope）—— 主结果照常返回，这一列空着
			} finally {
				docs = DOCS.map(d => ({ ...d }));
				await altStore.clear();
			}
		}

		const rows = report.rows.map(r => ({
			/** 假命中的判据用 SDK 那一份 —— 重算一遍就得自己记住 bypassed 不算复用 */
			falseHit: r.falseHit,
			key: r.key,
			label: r.label,
			note: byKey.get(r.key)?.note ?? "",
			caveat: byKey.get(r.key)?.caveat ?? null,
			nowHandledBy: byKey.get(r.key)?.nowHandledBy ?? null,
			coveredUnder: covered.get(r.key) ?? null,
			ok: r.ok,
			got: (r.outcome === "generated" ? "regenerate" : "reuse") as "reuse" | "regenerate",
			space: r.actualSpace,
			expectSpace: r.expectSpace,
			exitedAt: r.exitedAt,
		}));

		// 已移交的不计入假命中/漏命中 —— 它们测的是一道已经不存在的闸
		const counted = rows.filter(r => r.nowHandledBy === null);
		return {
			rows,
			total: report.total,
			falseHit: counted.filter(r => r.falseHit).length,
			missed: counted.filter(r => !r.ok && !r.falseHit).length,
			movedOut: rows.length - counted.length,
		};
	}

	/**
	 * 单条场景回放：播种 → （可选改版）→ 探测，全程在自己的缓存里。
	 *
	 * 先前这是浏览器端的四次调用（reset → ask → bump → ask），第一步就把手动
	 * 缓存清了。挪到服务端一次做完，手动那边什么都不会少。
	 */
	async function scenario(key: string, override?: Partial<LabConfig>): Promise<LabScenarioResult | null> {
		const sc = SCENARIOS.find(s => s.key === key);
		if (!sc) return null;
		const cfg: LabConfig = { ...defaults, ...override };
		const main = await replay(sc, cfg);

		/**
		 * 「已移交」的场景再跑一遍它该归属的那个配置。
		 *
		 * 这一条是给点开这条场景的人看的：它现在会命中，而页面必须当场回答「那谁来管」。
		 * 只讲不跑的话，DESIGN 里「代价由隔离边界来付」就只是一句声明。
		 */
		if (sc.nowHandledBy === undefined) return { ...main, handedTo: null };
		const plan = COVERAGE[sc.nowHandledBy];
		try {
			const alt = await replay(sc, { ...cfg, ...plan.override });
			return {
				...main,
				handedTo: {
					config: plan.config,
					decision: alt.decision,
					space: alt.space,
					exitedAt: alt.exitedAt,
					outcome: alt.outcome,
				},
			};
		} catch (err) {
			// 那个配置被 SDK 拒了也是有效结果，如实说，别让整条场景变成 500
			return { ...main, handedTo: { config: plan.config, rejected: String(err instanceof Error ? err.message : err) } };
		}
	}

	/** 播种 →（可选改版）→ 探测，跑在一份一次性缓存上。 */
	async function replay(sc: LabScenario, cfg: LabConfig): Promise<LabResult> {
		const isolated = createMemoryCacheStore();
		const cache = build(cfg, isolated);
		const snapshot = docs.map(d => ({ ...d }));
		try {
			await cache.resolve(toRequest(sc.seed, cfg), (p, c) => generator.generate(p, c));
			if (sc.bumpCorpus) await revise(cache, sc, cfg);
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
		metrics: () => metrics.snapshot(),
		resetMetrics: () => metrics.reset(),
		generator: { kind: generator.kind, note: generator.note, approxMsPerCall: generator.approxMsPerCall },
		defaults,
		calibration,
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
	};
}

export { compare };
