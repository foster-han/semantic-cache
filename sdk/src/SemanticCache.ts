import { cosine, hashKey, normalizeKey } from "./VectorMath.ts";
import type { RecallStage, RerankStage, SupportStage } from "./types/Calibration.ts";
import type { CacheEntry, CacheStore } from "./types/CacheStore.ts";
import type { Chunk, Retriever, SourceVersionResolver } from "./types/Retrieval.ts";
import type {
	CachedPayload,
	CachePrompt,
	CacheResult,
	GateId,
	GateSwitches,
	GateTrace,
	Generate,
	LookupResult,
	Refine,
	ScopeResolver,
	WriteItem,
	WriteOptions,
	WriteTicket,
} from "./types/Pipeline.ts";

/**
 * 阈值**没有默认值**，必须由调用方连同打分器一起给出。
 *
 * 给默认阈值等于鼓励不标定 —— 而一个没在你自己数据上标过的阈值，
 * 数值再合理也只是别人语料上的产物。
 */
export const DEFAULT_GATES: GateSwitches = {
	sourceVersion: true,
	answerCheck: true,
};

export interface SemanticCacheOptions {
	/** ③ 召回：打分器与**为它标定的**余弦下限 */
	readonly recall: RecallStage;
	/** ⑥ 回答校验：打分器与为它标定的两档支撑度阈值 */
	readonly support: SupportStage;
	/**
	 * ④ 精排：打分器与为它标定的闸值。
	 * **不提供就是没有这道闸**，不会退化成拿它的闸值去卡召回余弦。
	 */
	readonly rerank?: RerankStage;
	readonly store: CacheStore;
	readonly retriever: Retriever;
	readonly scope: ScopeResolver;
	readonly sourceVersion: SourceVersionResolver;
	readonly refine?: Refine;
	readonly gates?: Partial<GateSwitches>;
	/** ③ 召回条数。**必须大于 1**，否则 ④ 精排无候选可排。 */
	readonly recallLimit?: number;
	readonly ttlMs?: number | null;
	readonly newId?: () => string;
	/**
	 * 进程内合流：并发的同一个问题只生成一次。默认开。
	 * 关掉的场景是每个请求的 `generate` 或 `writeOptions` 必须各自生效。
	 */
	readonly singleFlight?: boolean;
	readonly now?: () => number;
}

type RedactionGuard = (kind: "answer" | "plan") => void;

/**
 * 脱敏 + 共享 scope 是否危险，取决于**缓存的是什么**。
 *
 * answer 条目危险：它含实体特定内容，脱敏后不同主体塌成同一个键，跨主体复用张冠李戴。
 * plan 条目不危险：实体只是参数，执行时用当前请求的实体填参、当场授权 ——
 * 塌陷反而正是所求，一个模板服务所有人。
 */
function makeRedactionGuard(prompt: CachePrompt, scope: string, shared: boolean): RedactionGuard {
	return kind => {
		if (kind !== "answer" || prompt.redacted !== true || !shared) return;
		throw new Error(
			`脱敏请求命中/写入了共享 scope「${scope}」里的 answer 条目。脱敏后不同主体会塌成同一个` +
				`缓存键，而答案含实体特定内容，跨主体复用必然张冠李戴。可选：` +
				`(a) ScopeResolver 对这类请求返回 { key, shared: false } 按主体隔离；` +
				`(b) 改成缓存 kind:"plan"（实体做参数，执行时填参 + 授权）—— 工具类问题应当走这一条；` +
				`(c) 不缓存。`,
		);
	};
}

function payloadOf(entry: CacheEntry): CachedPayload {
	return entry.kind === "plan"
		? { kind: "plan", plan: entry.plan }
		: { kind: "answer", answer: entry.answer, sourceIds: entry.sourceIds };
}

/** 余弦尺度的阈值。超出 [-1, 1] 的值不会报错，只会让那道闸永远放行或永远拦下。 */
function assertCosineThreshold(name: string, value: number): void {
	if (!Number.isFinite(value) || value < -1 || value > 1) {
		throw new Error(
			`${name} 是余弦尺度的阈值，必须落在 [-1, 1]，收到 ${String(value)}。` +
				"越界的阈值不会报错，只会让那道闸永远放行或永远拦下 —— 静默失效。",
		);
	}
}

function assertCalibratedOn(stage: string, value: string): void {
	if (value.trim() === "") {
		throw new Error(
			`${stage}.calibratedOn 不能是空串。阈值离开标定语境就没有意义，写一句话记下它是在什么数据、` +
				"什么算子下标出来的 —— 比事后考古便宜得多。",
		);
	}
}

/**
 * 分层语义缓存。
 *
 *   ① scope 门控 —— 由调用方的 ScopeResolver 决定隔离边界
 *   ② 精确匹配   —— 归一化哈希
 *   ③ 向量召回   —— top-k，k 必须 > 1
 *   ④ 精排       —— 主精度杠杆
 *   ⑤ 资料版本   —— 确定性判据，不用相似度判过期。仅对 answer 条目适用
 *   ⑥ 回答校验   —— 旧答案是否仍被检索片段支撑。仅对 answer 条目适用
 *
 * ② 命中也要过 ⑤⑥：缓存键建在脱敏文本上时，占位符塌陷对精确匹配同样成立。
 */
export function createSemanticCache(options: SemanticCacheOptions) {
	const gates: GateSwitches = { ...DEFAULT_GATES, ...options.gates };
	const recall = options.recall;
	const support = options.support;
	const rerank = options.rerank;
	const recallLimit = options.recallLimit ?? 5;
	const ttlMs = options.ttlMs === undefined ? 60 * 60 * 1000 : options.ttlMs;
	const now = options.now ?? (() => Date.now());
	const singleFlight = options.singleFlight ?? true;
	let counter = 0;
	/**
	 * 「时间戳 + 进程内计数器」在多实例部署下会碰撞：两个进程在同一毫秒内都写
	 * counter=1，得到同一个 id。加一段每实例只生成一次的随机后缀就够了。
	 *
	 * 不用 `crypto.randomUUID()`：v4 是纯随机，做主键会打散 btree 的插入局部性，
	 * 而缓存恰好写入频繁。这里的 id 仍然是时间有序的，顺序插入。
	 * 也不需要密码学随机 —— id 不是秘密，只是要避开碰撞。
	 */
	const instance = `${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 6)}`;
	const newId = options.newId ?? (() => `${now().toString(36)}-${(counter += 1).toString(36)}-${instance}`);

	if (recallLimit < 2) {
		throw new Error(
			"recallLimit 必须大于 1。只召回 1 条时没有候选集：④ 精排无从排起（现在或以后加上时），" +
				"任何关于「精排值不值」的 A/B 也都不成立 —— 你比的是两个二元判断。",
		);
	}

	/**
	 * 阈值的合法性在构造期查。
	 *
	 * **只有余弦尺度的阈值能查范围。** ④ 用的是重排器自己的分数尺度（可能是 logit，
	 * 也可能是 sigmoid 之后的概率），给它套 [-1, 1] 是又一次尺度混用 —— 那正是这套
	 * 类型设计一路在防的事。所以 rerank 的闸值只查「是不是有限数」。
	 */
	assertCosineThreshold("recall.thresholds.floor", recall.thresholds.floor);
	assertCosineThreshold("support.thresholds.high", support.thresholds.high);
	assertCosineThreshold("support.thresholds.low", support.thresholds.low);
	if (support.thresholds.high < support.thresholds.low) {
		throw new Error(
			`support 的置信带反了：high ${support.thresholds.high} < low ${support.thresholds.low}。` +
				"high 是「直接复用」的下界，low 是「驱逐」的上界，中间那段才是微调带。",
		);
	}
	if (rerank && !Number.isFinite(rerank.thresholds.floor)) {
		throw new Error(`rerank.thresholds.floor 必须是有限数，收到 ${String(rerank.thresholds.floor)}。`);
	}
	/**
	 * `target` 决定 ④ 拿什么当 candidate，因而决定分数尺度。类型上它是联合类型，
	 * 但 JS 调用方绕得过去 —— 而一个拼错的 target 会静默落到「不是 answer 就当
	 * question」那一支，拿问↔答标定的 θq 去卡问↔问的分数。所以运行期也查一次。
	 */
	if (rerank && rerank.thresholds.target !== "question" && rerank.thresholds.target !== "answer") {
		throw new Error(
			`rerank.thresholds.target 必须是 "question" 或 "answer"，收到 ${JSON.stringify(rerank.thresholds.target)}。` +
				"它决定 ④ 把旧问题还是旧答案递给重排器 —— 两者尺度不同，θq 不通用。",
		);
	}
	assertCalibratedOn("recall", recall.calibratedOn);
	assertCalibratedOn("support", support.calibratedOn);
	if (rerank) assertCalibratedOn("rerank", rerank.calibratedOn);

	/* ------------------------------------------------------------------ *
	 * 匹配 —— 只读路径。跑 ①～⑥，不生成、不写新条目。
	 * ------------------------------------------------------------------ */

	async function lookup(prompt: CachePrompt): Promise<LookupResult> {
		const trace: Array<GateTrace> = [];
		const decision = await options.scope(prompt);
		const scope = typeof decision === "string" ? decision : decision.key;
		const shared = typeof decision === "string" ? true : decision.shared;
		const guard = makeRedactionGuard(prompt, scope, shared);

		trace.push({
			gate: 1,
			name: "scope 门控",
			verdict: "pass",
			detail: `scope = ${scope}${shared ? "（共享）" : "（隔离）"}${prompt.redacted ? " · 已脱敏" : ""}`,
		});

		const normalized = normalizeKey(prompt.matchText);
		const matchHash = hashKey(normalized);

		/**
		 * 召回向量只有走到写入路径才用得上。② 精确命中时急着算它，等于让
		 * 「微秒级」的那一层每次都付一次模型调用 —— 惰性求值并记忆化。
		 */
		let ticket: WriteTicket | null = null;
		async function prepareWrite(): Promise<WriteTicket> {
			ticket ??= {
				scope,
				shared,
				matchHash,
				matchVector: (await recall.scorer.embedQuestions([prompt.matchText]))[0],
			};
			return ticket;
		}

		function miss(exitedAt: GateId, chunks: ReadonlyArray<Chunk> | null, support: number | null): LookupResult {
			return { outcome: "miss", payload: null, entryId: null, sourceIds: [], exitedAt, trace, chunks, support, prepareWrite };
		}

		/* ② 精确匹配 */
		const candidate = await options.store.getByHash(scope, matchHash);
		// 哈希命中还不够：matchHash 是非密码学哈希，一次碰撞就会返回一条完全无关的
		// 答案，而这一层的全部价值在于零假命中风险。所以再比一次原文，不依赖存储实现。
		const exact = candidate && normalizeKey(candidate.matchText) === normalized ? candidate : null;
		if (exact) {
			trace.push({ gate: 2, name: "精确匹配", verdict: "hit", detail: `命中条目 ${exact.id}` });
			return verify(exact, prompt, trace, guard, prepareWrite, true);
		}
		trace.push({
			gate: 2,
			name: "精确匹配",
			verdict: "miss",
			detail: candidate ? "哈希命中但原文不符（碰撞），按未命中处理" : "无逐字相同的条目",
		});

		/* ③ 向量召回 */
		const [matchVector] = await recall.scorer.embedQuestions([prompt.matchText]);
		// 已经算出来了，顺手把票据填上，写入路径不必再编一次
		ticket = { scope, shared, matchHash, matchVector };
		const candidates = await options.store.searchNearest(scope, matchVector, recallLimit);
		if (candidates.length === 0 || candidates[0].similarity < recall.thresholds.floor) {
			const top = candidates[0]?.similarity;
			trace.push({
				gate: 3,
				name: `向量召回 top-${recallLimit}`,
				verdict: "exit",
				detail: candidates.length === 0 ? "该 scope 下没有候选" : `最高余弦 ${top?.toFixed(4)} 低于召回下限`,
				score: top,
			});
			return miss(3, null, null);
		}
		trace.push({
			gate: 3,
			name: `向量召回 top-${recallLimit}`,
			verdict: "pass",
			detail: `${candidates.length} 条候选`,
			score: candidates[0].similarity,
		});

		/* ④ 精排。没有 RerankStage 就是没有这道闸 —— 不做任何尺度混用的退化。 */
		let best = candidates[0].entry;
		if (rerank) {
			const target = rerank.thresholds.target;
			/**
			 * `target: "answer"` 下 plan 条目**没有可比的 candidate**：`entry.answer`
			 * 对它们是空串。三种处置里只有一种不撒谎：
			 *
			 *   - 拿空串去打分 → 必然低分，plan 条目被 ④ 全部拦掉，且不报错
			 *   - 回落到 `matchText` → 拿问↔答标定的 θq 去卡问↔问的分数，尺度混用
			 *   - **这道闸对它们不适用** ← 选用
			 *
			 * 和 ⑤⑥ 对 plan 不适用是同一个道理，DESIGN 里已经立了这个先例。
			 * 不适用不等于淘汰：它们保持 ③ 的余弦名次继续往下走。
			 */
			const rerankable = target === "answer" ? candidates.filter(c => c.entry.kind === "answer") : [...candidates];
			const skipped = candidates.length - rerankable.length;

			if (rerankable.length === 0) {
				trace.push({
					gate: 4,
					name: "精排",
					verdict: "off",
					detail:
						`target = "answer"，但 ${candidates.length} 条候选全是 plan 条目（没有答案文本可比）—— ` +
						"这道闸对 plan 不适用，按 ③ 的余弦名次取 top-1",
				});
			} else {
				const scored: Array<{ entry: CacheEntry; score: number }> = [];
				for (const c of rerankable) {
					const candidateText = target === "answer" ? c.entry.answer : c.entry.matchText;
					scored.push({ entry: c.entry, score: await rerank.scorer.score(prompt.matchText, candidateText) });
				}
				scored.sort((a, b) => b.score - a.score);
				best = scored[0].entry;
				const questionScore = scored[0].score;
				const scaleNote = `${target === "answer" ? "问↔答" : "问↔问"}尺度`;
				const skipNote = skipped === 0 ? "" : `，另有 ${skipped} 条 plan 条目不适用本闸`;
				if (questionScore < rerank.thresholds.floor) {
					trace.push({
						gate: 4,
						name: "精排",
						verdict: "exit",
						detail:
							`分数 ${questionScore.toFixed(4)} 低于闸值 ${rerank.thresholds.floor}（${scaleNote}` +
							`，标定于：${rerank.calibratedOn}）${skipNote}`,
						score: questionScore,
					});
					return miss(4, null, null);
				}
				trace.push({
					gate: 4,
					name: "精排",
					verdict: "pass",
					detail: `过闸（${scaleNote}）${skipNote}`,
					score: questionScore,
				});
			}
		} else {
			trace.push({
				gate: 4,
				name: "精排",
				verdict: "off",
				detail: "未提供 RerankStage —— 问题侧只由 ③ 的召回下限把关",
			});
		}

		return verify(best, prompt, trace, guard, prepareWrite, false);
	}

	/**
	 * ⑤ ⑥ 与置信带。**被判定失效的条目在这里驱逐** —— 那是维护而不是写入：
	 * 一条版本已过期或已不被语料支撑的缓存，读到它的那一刻就该消失。
	 * 中带条目不驱逐：它没失效，只是不够有把握，留不留由上层决定。
	 */
	async function verify(
		entry: CacheEntry,
		prompt: CachePrompt,
		trace: Array<GateTrace>,
		guard: RedactionGuard,
		prepareWrite: () => Promise<WriteTicket>,
		wasExact: boolean,
	): Promise<LookupResult> {
		// 快速失败：脱敏 × 共享 × answer 是必然出错的组合，早点抛，
		// 别先付掉一次检索和两次 embedding 再抛。
		guard(entry.kind);

		/* plan 条目：不依赖语料、无实体特定内容 —— ⑤⑥ 都不适用 */
		if (entry.kind === "plan") {
			trace.push({ gate: 5, name: "资料版本比对", verdict: "off", detail: "plan 条目不依赖语料" });
			trace.push({
				gate: 6,
				name: "回答有效性校验",
				verdict: "off",
				detail: "plan 条目无实体特定内容 —— 实体是参数，执行时填参并授权",
			});
			return {
				outcome: wasExact ? "exact" : "reuse",
				payload: payloadOf(entry),
				entryId: entry.id,
				sourceIds: [],
				exitedAt: null,
				trace,
				chunks: null,
				support: null,
				prepareWrite,
			};
		}

		/* ⑤ 资料版本 —— 无论开关都算，好让 A/B 看清关掉的代价 */
		const currentVersion = await options.sourceVersion(entry.sourceIds);
		const stale = currentVersion !== entry.sourceVersion;
		if (stale && gates.sourceVersion) {
			trace.push({
				gate: 5,
				name: "资料版本比对",
				verdict: "exit",
				detail: `版本不符（写入时 ${entry.sourceVersion} → 当前 ${currentVersion}），驱逐 ${entry.id}`,
			});
			await options.store.evict(entry.id);
			return { outcome: "miss", payload: null, entryId: null, sourceIds: [], exitedAt: 5, trace, chunks: null, support: null, prepareWrite };
		}
		trace.push({
			gate: 5,
			name: "资料版本比对",
			verdict: stale ? "would-exit" : gates.sourceVersion ? "pass" : "off",
			detail: stale ? "版本不符，但该闸已关闭 —— 过期答案会被放行" : "版本一致",
		});

		/* ⑥ 回答有效性 —— 检索必须用保留实体的原文 */
		const chunks = await options.retriever.retrieve(prompt.retrievalText, prompt.context);

		/**
		 * **「判不了」和「判定为无效」必须分开。**
		 *
		 * 没有片段时 supportScore 返回 0，必然低于 low。先前这里直接驱逐，于是
		 * retriever 一次故障（向量库超时、索引重建、连接断）就会让**每一次读都顺手
		 * 删掉它读到的那条缓存** —— 一次故障可以静默清空整个缓存，而且从日志上看
		 * 每一条都"依法驱逐"。缺证据不是有罪。
		 *
		 * 本次仍然不复用（保守），但条目留着。
		 */
		if (gates.answerCheck && (chunks.length === 0 || entry.answerVector.length === 0)) {
			trace.push({
				gate: 6,
				name: "回答有效性校验",
				verdict: "exit",
				detail: chunks.length === 0 ? "检索没有返回任何片段，判不了 —— 本次不复用，但不驱逐" : "条目没有答案向量，判不了 —— 本次不复用，但不驱逐",
			});
			return { outcome: "miss", payload: null, entryId: null, sourceIds: [], exitedAt: 6, trace, chunks, support: null, prepareWrite };
		}

		const supportValue = await supportScore(entry, chunks);
		const wouldExit = supportValue < support.thresholds.low;
		if (gates.answerCheck && wouldExit) {
			trace.push({
				gate: 6,
				name: "回答有效性校验",
				verdict: "exit",
				detail: `支撑度 ${supportValue.toFixed(4)} 低于 ${support.thresholds.low}（标定于：${support.calibratedOn}），驱逐 ${entry.id}`,
				score: supportValue,
			});
			await options.store.evict(entry.id);
			return { outcome: "miss", payload: null, entryId: null, sourceIds: [], exitedAt: 6, trace, chunks, support: supportValue, prepareWrite };
		}
		trace.push({
			gate: 6,
			name: "回答有效性校验",
			verdict: !gates.answerCheck ? "off" : wouldExit ? "would-exit" : "pass",
			detail: !gates.answerCheck
				? `已关闭（支撑度本会是 ${supportValue.toFixed(4)}${wouldExit ? "，本该拦下" : ""}）`
				: `支撑度 ${supportValue.toFixed(4)}`,
			score: supportValue,
		});

		/* 置信带 */
		const confident = supportValue >= support.thresholds.high || !gates.answerCheck;
		return {
			outcome: confident ? (wasExact ? "exact" : "reuse") : "mid",
			payload: payloadOf(entry),
			entryId: entry.id,
			sourceIds: entry.sourceIds,
			exitedAt: null,
			trace,
			chunks,
			support: supportValue,
			prepareWrite,
		};
	}

	/**
	 * 支撑度 = 旧答案与**首个**检索片段的余弦。
	 *
	 * 算子选择踩过两次坑，都不是小事：
	 *
	 * - **重心（centroid）**：一门课只有两三篇文档时，top-k 会把无关的也捞回来，
	 *   平均之后信号被稀释，实体塌陷拦不住。
	 * - **取 max**：语义是「有某个片段撑得住旧答案」——可旧答案**自己的来源片段**
	 *   往往还在 top-k 里，跟自己比当然高分，max 被它顶起来。实测里
	 *   Vapnik→Breiman 那条就是这样漏的：问 Breiman，检索回来的三篇里仍有
	 *   Vapnik 那篇，而缓存答案正是从它生成的。
	 *
	 * 正确的语义是「旧答案和**现在会据以回答的那篇**一不一致」，也就是 top-1。
	 * 这同时保证了标定与实现用的是同一个算子 —— 标定时拿单篇文档比、实现却取
	 * top-k 的 max，标出来的阈值根本不适用。
	 */
	async function supportScore(entry: CacheEntry, chunks: ReadonlyArray<Chunk>): Promise<number> {
		if (chunks.length === 0 || entry.answerVector.length === 0) return 0;
		const [top] = await support.scorer.embedPassage([chunks[0].text]);
		return cosine(entry.answerVector, top);
	}

	/* ------------------------------------------------------------------ *
	 * 写入
	 * ------------------------------------------------------------------ */

	/** 没有 lookup 结果可用时，现算一份写入票据。 */
	async function prepareTicket(prompt: CachePrompt): Promise<WriteTicket> {
		const decision = await options.scope(prompt);
		return {
			scope: typeof decision === "string" ? decision : decision.key,
			shared: typeof decision === "string" ? true : decision.shared,
			matchHash: hashKey(normalizeKey(prompt.matchText)),
			matchVector: (await recall.scorer.embedQuestions([prompt.matchText]))[0],
		};
	}

	/**
	 * 票据必须来自**同一个 prompt** 的 `lookup()`。配错了是构造上必然的错误，
	 * 而且完全静默，所以在这里堵死：
	 *
	 * - **文本对不上**：条目的 `matchText` 是这次的，`matchHash` / `matchVector`
	 *   却是上次的。② 用这次的文本算哈希查不到它；③ 会用上次的向量把它召回，
	 *   然后拿这次的 `matchText` 去做 ④ 精排。这条缓存写进去就再也读不回来。
	 * - **scope 对不上**：同一句话、不同的 `context`（比如另一门课、另一个租户），
	 *   条目会落进票据那一侧的 scope。这比读不回来更糟 —— 它是跨边界写入。
	 */
	function assertTicketMatches(
		ticket: WriteTicket,
		prompt: CachePrompt,
		scope: string,
		shared: boolean,
		matchHash: string,
	): void {
		if (ticket.matchHash !== matchHash) {
			throw new Error(
				`写入票据与 prompt 不是同一个问题：票据的 matchHash 是 ${ticket.matchHash}，` +
					`而 matchText「${prompt.matchText}」算出来是 ${matchHash}。` +
					`票据只能来自同一个 prompt 的 lookup().prepareWrite() —— 混用会写出一条永远读不回来的缓存。`,
			);
		}
		if (ticket.scope !== scope || ticket.shared !== shared) {
			throw new Error(
				`写入票据与 prompt 的隔离边界不一致：票据是 ${ticket.scope}（${ticket.shared ? "共享" : "隔离"}），` +
					`而这个 prompt 现在解析出 ${scope}（${shared ? "共享" : "隔离"}）。` +
					`同一句话在不同 context 下属于不同 scope，照票据写会写进另一边。`,
			);
		}
	}

	/**
	 * 批量写入。`write` 是它的单条包装 —— 只有一份实现，向量空间、版本指纹和
	 * 脱敏守卫因此只有一份口径。
	 *
	 * **批量不是为了少写几行**：两次批量编码代替 2N 次单条调用。灌 30 条干扰缓存
	 * 或从历史日志回填时，差的是 2 次模型调用还是 60 次。
	 *
	 * 守卫在任何编码之前跑完：脱敏 × 共享 × answer 是必然出错的组合，
	 * 没必要先付掉一整批 embedding 再抛。
	 */
	async function writeMany(items: ReadonlyArray<WriteItem>): Promise<Array<CacheEntry>> {
		if (items.length === 0) return [];

		/**
		 * scope 与哈希**每条都现算**，带了票据也算 —— 然后跟票据核对。
		 *
		 * 票据省下的是那次 embedding，不是这两样：它们本来就便宜（一次字符串哈希、
		 * 一次通常是纯函数的 ScopeResolver 调用），而票据配错 prompt 的后果不便宜。
		 * 见 assertTicketMatches。
		 */
		const prepared: Array<{ scope: string; shared: boolean; matchHash: string; matchVector: ReadonlyArray<number> | null }> = [];
		for (const item of items) {
			const decision = await options.scope(item.prompt);
			const scope = typeof decision === "string" ? decision : decision.key;
			const shared = typeof decision === "string" ? true : decision.shared;
			const matchHash = hashKey(normalizeKey(item.prompt.matchText));
			const ticket = item.options?.ticket;
			if (ticket) assertTicketMatches(ticket, item.prompt, scope, shared, matchHash);
			prepared.push({ scope, shared, matchHash, matchVector: ticket?.matchVector ?? null });
		}

		// 守卫必须在 put 之前 —— 落库之后再抛就已经污染了缓存
		for (let i = 0; i < items.length; i++) {
			makeRedactionGuard(items[i].prompt, prepared[i].scope, prepared[i].shared)(items[i].payload.kind);
		}

		/* 一次编码所有缺失的召回向量 */
		const missing: Array<number> = [];
		for (let i = 0; i < prepared.length; i++) if (prepared[i].matchVector === null) missing.push(i);
		if (missing.length > 0) {
			const vectors = await recall.scorer.embedQuestions(missing.map(i => items[i].prompt.matchText));
			for (let k = 0; k < missing.length; k++) prepared[missing[k]].matchVector = vectors[k];
		}

		/* 一次编码所有答案。答案向量必须落在 passage 空间才能和检索片段比；plan 不需要 */
		const answerIndexes: Array<number> = [];
		for (let i = 0; i < items.length; i++) if (items[i].payload.kind === "answer") answerIndexes.push(i);
		const answerVectors = new Map<number, ReadonlyArray<number>>();
		if (answerIndexes.length > 0) {
			const encoded = await support.scorer.embedPassage(
				answerIndexes.map(i => {
					const payload = items[i].payload;
					return payload.kind === "answer" ? payload.answer : "";
				}),
			);
			for (let k = 0; k < answerIndexes.length; k++) answerVectors.set(answerIndexes[k], encoded[k]);
		}

		const written: Array<CacheEntry> = [];
		for (let i = 0; i < items.length; i++) {
			const { prompt, payload } = items[i];
			const slot = prepared[i];
			const isAnswer = payload.kind === "answer";
			const sourceIds = isAnswer ? payload.sourceIds : [];
			const created = now();
			// 显式给了 ttlMs 就用它（含 null = 不过期），没给才落到全局默认
			const ttl = items[i].options?.ttlMs === undefined ? ttlMs : items[i].options?.ttlMs;

			const entry: CacheEntry = {
				id: newId(),
				scope: slot.scope,
				kind: payload.kind,
				matchText: prompt.matchText,
				matchHash: slot.matchHash,
				matchVector: slot.matchVector ?? [],
				answer: isAnswer ? payload.answer : "",
				plan: isAnswer ? {} : payload.plan,
				answerVector: answerVectors.get(i) ?? [],
				sourceIds,
				sourceVersion: isAnswer ? await options.sourceVersion(sourceIds) : "",
				createdAt: created,
				expiresAt: ttl === null || ttl === undefined ? null : created + ttl,
				meta: items[i].options?.meta,
			};
			/**
			 * 写入前查一次「同一个问题是否已经有条目」。
			 *
			 * 并发未命中是这里唯一的来源：进程内有合流挡着，跨进程挡不住 ——
			 * 两个进程各自生成、各自写入，就留下两行同 `(scope, matchHash)`。
			 * 这一次查询把重复窗口从**整个生成时长**（秒级）缩到**一次往返**
			 * （毫秒级），而两次生成几乎不会在同一毫秒结束。
			 *
			 * **比原文，不只比哈希。** `matchHash` 是非密码学哈希，一次碰撞是
			 * 两个完全不同的问题 —— 它们该共存，不该互相覆盖。这正是 ② 在读路径上
			 * 的做法（哈希命中之后再比一次原文），这里只是把同一条规矩用到写入侧。
			 *
			 * 没有做成 `(scope, match_hash)` 唯一索引：那会让一次碰撞变成两个问题
			 * 永久互相踢，而且要动 schema、要改 `put` 语义、要再改一次 `entryId`
			 * 语义。重复行是**良性**的（`getByHash` 确定性取最新，③ 顶多浪费一个
			 * 候选位），不值得为它换一次契约变更。理由见 DESIGN.md 的并发一节。
			 */
			const normalized = normalizeKey(prompt.matchText);
			const existing = await options.store.getByHash(slot.scope, slot.matchHash);
			const duplicate =
				existing && existing.id !== items[i].options?.supersedes && normalizeKey(existing.matchText) === normalized
					? existing.id
					: null;

			await options.store.put(entry);

			// 先写后删。多于两行时一次只收一条，靠后续写入收敛 —— 反正读路径不受影响。
			for (const stale of new Set([items[i].options?.supersedes, duplicate])) {
				if (stale !== undefined && stale !== null) await options.store.evict(stale);
			}
			written.push(entry);
		}
		return written;
	}

	/**
	 * 写一条缓存。`resolve` 的生成与微调两条路径也走这里。
	 *
	 * `options.ticket` 传的是 `lookup()` 那次已经算好的 scope / 哈希 / 向量；
	 * 不传就现算，代价是多一次 scope 解析和一次 embedding。
	 */
	async function write(prompt: CachePrompt, produced: CachedPayload, writeOptions?: WriteOptions): Promise<CacheEntry> {
		const [entry] = await writeMany([{ prompt, payload: produced, options: writeOptions }]);
		return entry;
	}

	/* ------------------------------------------------------------------ *
	 * 获取与失效
	 * ------------------------------------------------------------------ */

	/** 按 id 取条目。只返回未过期的 —— 已过期未清理的原始状态看存储的 `all()`。 */
	async function get(entryId: string): Promise<CacheEntry | null> {
		return options.store.getById(entryId);
	}

	/** 删一条或一批。批量删除在「按 lookup 结果清理」这种场景下才够用。 */
	async function evict(entryId: string | ReadonlyArray<string>): Promise<void> {
		for (const id of typeof entryId === "string" ? [entryId] : entryId) await options.store.evict(id);
	}

	/**
	 * 清空一个 scope，返回删掉的条数。课程归档、租户注销、老师要求重置走这里。
	 *
	 * **必须给 scope。** 无参数的全清在生产上几乎总是误操作，真要全清就对存储调
	 * `InspectableCacheStore.clear()` —— 让它显眼一点，别藏在缓存对象的方法里。
	 */
	async function clear(scope: string): Promise<number> {
		return options.store.clearScope(scope);
	}

	/**
	 * 资料改版时按资料 id 批量失效，返回删掉的条数。
	 *
	 * ⑤ 是**读时**的懒失效：条目要等到被读到才发现版本不符。老师改完大纲就调一次
	 * 这个，等于把那一批的失效提前到写时 —— 两者不是二选一，⑤ 仍然是兜底。
	 */
	async function invalidateSource(sourceId: string): Promise<number> {
		return options.store.evictBySource(sourceId);
	}

	/**
	 * 删掉已过期的条目，返回删掉的条数。
	 *
	 * **不影响正确性** —— 读路径本来就把过期条目挡在外面。不调的话过期行会一直
	 * 留在存储里，pgvector 那边还会拖慢 scope 内的精确 KNN。挂个定时任务即可。
	 */
	async function purgeExpired(): Promise<number> {
		return options.store.purgeExpired();
	}

	/* ------------------------------------------------------------------ *
	 * 组合：匹配 → 命中就用，未命中就生成并写回
	 * ------------------------------------------------------------------ */

	/**
	 * 值不值得写进缓存。
	 *
	 * **没有任何资料依据的 answer 不写。** 检索故障时（向量库超时、索引重建）生成
	 * 出来的就是这种东西：⑤ 够不着它（版本指纹恒为空串，永远"一致"），
	 * `invalidateSource` 也够不着（按资料 id 的批量失效匹配不到空数组），而
	 * `getByHash` 取最新 —— 它会稳稳地顶掉那条本来好好的旧缓存。
	 *
	 * ⑥ 那边把"判不了"和"判定为无效"分开了，故障期间不再删缓存；这里是另一半：
	 * 故障期间也不往里写。两半都到位，一次检索故障才真的不改变缓存状态。
	 *
	 * plan 条目不依赖语料，本来就没有 sourceIds，照写。
	 */
	function cacheable(payload: CachedPayload): boolean {
		return payload.kind === "plan" || payload.sourceIds.length > 0;
	}

	/**
	 * 替换一条旧条目：**先写新的，写成了才删旧的。**
	 *
	 * 反过来（先删后写）看着更直觉，但那把「替换」变成了「先删掉，然后试着写一条」：
	 * 生成抛错、写入抛错、产物没有资料依据 —— 任何一种都让旧条目白白消失。实测过一次：
	 * 中带条目 + 一次生成失败 = 净丢一条本来还能用的缓存，而这正是「一次故障不改变
	 * 缓存状态」那条不变式要防的事（⑥ 判不了时不驱逐、无依据的答案不写入，是同一条的另两半）。
	 *
	 * 顺序反过来之后，同 (scope, matchHash) 的两条会共存几毫秒 —— 这是安全的：
	 * `getByHash` 的契约就是取最新的那条，读到的一定是替换后的那一条。
	 */
	/**
	 * 替换一条：写新的，成功后驱逐旧的。
	 *
	 * 驱逐由 `writeMany` 统一做（`supersedes`），和「写入前查重」是同一段逻辑 ——
	 * 两者都是「写完之后收掉一条该走的」，没必要两套。
	 */
	async function replaceEntry(
		supersededId: string,
		prompt: CachePrompt,
		payload: CachedPayload,
		writeOptions: WriteOptions | undefined,
		ticket: WriteTicket,
	): Promise<CacheEntry> {
		return write(prompt, payload, { ...writeOptions, ticket, supersedes: supersededId });
	}

	/**
	 * 合流键。
	 *
	 * **`retrievalText` 必须在键里。** 上游做了匿名化时，两个学生问同一句话会得到
	 * 相同的 `matchText`，但 `retrievalText` 里的实体不同 —— 那正是 ⑥ 存在的理由。
	 * 只按 matchText 合流，等于亲手制造这套东西一路在防的占位符塌陷。
	 */
	function flightKey(prompt: CachePrompt): string {
		const context = Object.entries(prompt.context)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${k}=${v}`)
			.join("&");
		return `${normalizeKey(prompt.matchText)}\u0000${prompt.retrievalText}\u0000${context}\u0000${prompt.redacted ? "1" : "0"}`;
	}

	/**
	 * 并发的同一个问题只走一次完整流程，后到的请求拿到同一个结果。
	 *
	 * 没有它的话，N 个并发未命中会各自生成一次、各自写一条 —— N 次 LLM 调用，
	 * 外加 N 条只有一条能被 ② 命中的重复条目。
	 *
	 * **合流的请求共享第一个请求的 `generate` 与 `writeOptions`**（也共享同一份
	 * trace —— 那份 trace 如实记录了实际发生的那一次判定）。所以后到者传的 `meta`
	 * 不会生效。只在同一个进程内合流；跨进程重复生成是浪费而不是错误，为它引入
	 * 分布式锁，故障面比省下的开销大。
	 */
	const flights = new Map<string, Promise<CacheResult>>();

	async function resolve(prompt: CachePrompt, generate: Generate, writeOptions?: WriteOptions): Promise<CacheResult> {
		if (!singleFlight) return resolveOnce(prompt, generate, writeOptions);
		const key = flightKey(prompt);
		const running = flights.get(key);
		if (running) return running;
		const started = resolveOnce(prompt, generate, writeOptions).finally(() => flights.delete(key));
		flights.set(key, started);
		return started;
	}

	async function resolveOnce(prompt: CachePrompt, generate: Generate, writeOptions?: WriteOptions): Promise<CacheResult> {
		const found = await lookup(prompt);
		const trace: Array<GateTrace> = [...found.trace];

		if (found.payload && (found.outcome === "exact" || found.outcome === "reuse")) {
			return {
				payload: found.payload,
				outcome: found.outcome,
				exitedAt: null,
				entryId: found.entryId,
				sourceIds: found.sourceIds,
				trace,
			};
		}

		/* 中带：有 refine 就短生成并写回替换，没有就退化成完整生成 */
		let superseded: string | null = null;
		if (found.outcome === "mid" && found.entryId) {
			if (options.refine && found.payload?.kind === "answer") {
				const refined = await options.refine(found.payload.answer, prompt, found.chunks ?? []);
				if (!cacheable(refined)) {
					// 旧条目还没删 —— 拿一个没有依据的微调结果去换掉它是净亏
					trace.push({ gate: 6, name: "中带处理", verdict: "exit", detail: "微调结果没有资料依据，不写回，旧条目保留" });
					return {
						payload: refined,
						outcome: "refine",
						exitedAt: null,
						entryId: found.entryId,
						sourceIds: [],
						trace,
					};
				}
				// 微调的产物要写回替换旧条目。不写回的话，下次同样的问题又落进中带、
				// 又微调一次 —— 短生成的钱一直在花，而每次算出的更好答案都被丢掉。
				const replacement = await replaceEntry(found.entryId, prompt, refined, writeOptions, await found.prepareWrite());
				trace.push({ gate: 6, name: "中带处理", verdict: "pass", detail: `微调后写回：${found.entryId} → ${replacement.id}` });
				return {
					payload: refined,
					outcome: "refine",
					exitedAt: null,
					// 旧条目已经删了。返回旧 id 的话调用方拿它去 get 只会拿到 null
					entryId: replacement.id,
					sourceIds: refined.kind === "answer" ? refined.sourceIds : [],
					trace,
				};
			}
			trace.push({
				gate: 6,
				name: "中带处理",
				verdict: "exit",
				detail: `未提供 refine，中带退化为完整生成；旧条目 ${found.entryId} 留到新答案写成之后再删`,
			});
			superseded = found.entryId;
		}

		const chunks = found.chunks ?? (await options.retriever.retrieve(prompt.retrievalText, prompt.context));
		const produced = await generate(prompt, chunks);
		if (!cacheable(produced)) {
			trace.push({
				gate: 6,
				name: "写入",
				verdict: "exit",
				detail: superseded
					? "答案没有任何资料依据，本次不写入缓存 —— 中带的旧条目因此保留"
					: "答案没有任何资料依据，本次不写入缓存",
			});
			return {
				payload: produced,
				outcome: "generated",
				exitedAt: found.outcome === "mid" ? 6 : found.exitedAt,
				// null 在这里有确切含义：生成了，但没有落缓存
				entryId: null,
				sourceIds: [],
				trace,
			};
		}
		const stored =
			superseded === null
				? await write(prompt, produced, { ...writeOptions, ticket: await found.prepareWrite() })
				: await replaceEntry(superseded, prompt, produced, writeOptions, await found.prepareWrite());
		return {
			payload: produced,
			outcome: "generated",
			// 中带落到这里是被 ⑥ 放弃的，如实记成 6
			exitedAt: found.outcome === "mid" ? 6 : found.exitedAt,
			// 刚写进去的那条。先前这里恒为 null —— 明明写了一条却拿不到它的 id
			entryId: stored.id,
			sourceIds: produced.kind === "answer" ? produced.sourceIds : [],
			trace,
		};
	}

	return { resolve, lookup, write, writeMany, get, evict, clear, invalidateSource, purgeExpired, prepareTicket, gates, recallLimit };
}

export type SemanticCache = ReturnType<typeof createSemanticCache>;
