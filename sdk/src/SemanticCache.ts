import { cosine, hashKey, normalizeKey } from "./VectorMath.ts";
import { composeScope } from "./Scope.ts";
import type { RecallStage, RerankStage } from "./types/Calibration.ts";
import type { CachePolicy } from "./types/CachePolicy.ts";
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
	LookupOutcome,
	LookupResult,
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
};

export interface SemanticCacheOptions {
	/** ③ 召回：打分器与**为它标定的**余弦下限 */
	readonly recall: RecallStage;
	/**
	 * ④ 精排：打分器与为它标定的闸值。
	 * **不提供就是没有这道闸**，不会退化成拿它的闸值去卡召回余弦。
	 */
	readonly rerank?: RerankStage;
	readonly store: CacheStore;
	readonly retriever: Retriever;
	readonly scope: ScopeResolver;
	readonly sourceVersion: SourceVersionResolver;
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
	/**
	 * 哪些 prompt 根本不该进缓存，在任何一道闸之前判。不给就是「全都可以缓存」。
	 *
	 * 判定 `bypass` 时 `lookup` 一道闸都不跑，并且**不发写入票据** ——
	 * 那类问题写进去一次，下一次就是假命中。
	 */
	readonly policy?: CachePolicy;
	/**
	 * 影子模式。默认 `false`。
	 *
	 * 打开后：闸照常全跑、新条目照常写入（否则缓存永远暖不起来），但**从不复用**，
	 * 而且读路径**严格只读** —— 不驱逐、不 touch。真实判定放在 `LookupResult.wouldHave`
	 * 与 `CacheResult.wouldReuse` 里，配 `Metrics` 的 `shadow.wouldReuseRate` 看
	 * 「真开了能命中多少」。
	 *
	 * 不驱逐是要点：⑤ 判负是破坏性的，而影子模式的目的恰恰是检验它判得对不对 ——
	 * 一边评估一边按评估结果删数据，等于用没验证过的判据毁掉证据。
	 */
	readonly shadow?: boolean;
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
 *
 * ② 命中也要过 ⑤：问题逐字相同，不代表它当初依据的那批资料还是老样子。
 *
 * 读路径上没有检索 —— `Retriever` 只在确定要生成时才调一次。
 */
/**
 * 绕开时的「票据」：调用它必然抛。
 *
 * 返回一个能用的票据、指望调用方自觉不写，等于没有守卫 —— 这套 API 一路的做法
 * 是让错误的用法拿不到东西，而不是让它拿到之后出问题。
 */
/**
 * 理由不能是空串。**`""` 不是 `null`** —— 不判一下的话，策略返回 `{ noCache: "" }`
 * 会静默绕开且没有任何解释，而这一层的全部意义就是让「为什么这条没缓存」有个答案。
 * 和 `assertCalibratedOn` 对 `calibratedOn` 的处理是同一条规矩。
 */
function assertReason(field: string, value: string | undefined): string | null {
	if (value === undefined) return null;
	if (value.trim() === "") {
		throw new Error(
			`CachePolicy 返回的 ${field} 是空字符串。要绕开就给出理由（它会进 trace 和看板）；不想绕开就别给这个字段。`,
		);
	}
	return value;
}

/**
 * 归一化之后的缓存键。**空白 `matchText` 在这里拦下。**
 *
 * `""` 与 `"   "` 归一化之后是同一个空串，于是它们互为 ② 精确命中：上游只要有一次
 * 「prompt 拼装出来是空的」，之后每一次空 prompt 都会拿到那条答案，而且是**精确
 * 命中**那条最可信的路 —— 不过闸、不算相似度、trace 上一切正常。
 *
 * 空 prompt 一定是上游的 bug，不是一类需要兜的输入，所以抛而不是当未命中：
 * 当未命中的话它会照常写入，等于把这条假命中的源头留在库里。
 */
function matchKeyOf(prompt: CachePrompt): { normalized: string; matchHash: string } {
	if (typeof prompt.matchText !== "string" || prompt.matchText.trim() === "") {
		throw new Error(
			`matchText 是空的（收到 ${JSON.stringify(prompt.matchText)}）。归一化之后是空串，` +
				"而空串之间互为 ② 精确命中 —— 上游一次空 prompt 写进去，之后每一次空 prompt 都会" +
				"精确命中它。缓存键必须来自真正的问题文本。",
		);
	}
	const normalized = normalizeKey(prompt.matchText);
	return { normalized, matchHash: hashKey(normalized) };
}

function bypassTicket(reason: string): () => Promise<WriteTicket> {
	return async function refuse(): Promise<WriteTicket> {
		throw new Error(`这个 prompt 被 CachePolicy 判定为不进缓存（${reason}），拿不到写入票据。要写入请先让 policy 放行。`);
	};
}

export function createSemanticCache(options: SemanticCacheOptions) {
	const gates: GateSwitches = { ...DEFAULT_GATES, ...options.gates };
	const recall = options.recall;
	const rerank = options.rerank;
	const recallLimit = options.recallLimit ?? 5;
	const ttlMs = options.ttlMs === undefined ? 60 * 60 * 1000 : options.ttlMs;
	const now = options.now ?? (() => Date.now());
	const singleFlight = options.singleFlight ?? true;
	/** 影子模式：读路径严格只读 —— 评估不该改变被评估的东西 */
	const shadow = options.shadow ?? false;
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

	if (!Number.isInteger(recallLimit) || recallLimit < 2) {
		throw new Error(
			`recallLimit 必须是大于 1 的整数，收到 ${String(options.recallLimit)}。` +
				"只召回 1 条时没有候选集：④ 精排无从排起（现在或以后加上时），任何关于「精排值不值」的 A/B " +
				"也都不成立 —— 你比的是两个二元判断。" +
				// 非整数不会在这里出事，它会在后端上出事，而且三个后端各出一种
				"非整数则是又一种静默分歧：内存后端 slice(2.5) 照样跑，pgvector 的 LIMIT $4 与 Redis 的 " +
				"VSIM COUNT 会在运行期报「不是整数」—— 本地跑通、上真库才炸。",
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
	if (rerank) assertCalibratedOn("rerank", rerank.calibratedOn);

	/**
	 * 解析隔离边界。**三条路径（lookup / prepareTicket / writeMany）必须走同一个实现** ——
	 * 先前是三份拷贝，任何一处改了组合方式，写进去的 scope 和读出来的就对不上，
	 * 表现是「明明写了却永远读不到」，而不会报错。
	 */
	async function resolveScope(prompt: CachePrompt): Promise<{ scope: string; shared: boolean }> {
		const decision = await options.scope(prompt);
		return { scope: composeScope(decision.org, decision.key), shared: decision.shared };
	}

	/* ------------------------------------------------------------------ *
	 * 匹配 —— 只读路径。跑 ①～⑤，不生成、不写新条目。
	 * ------------------------------------------------------------------ */

	async function lookup(prompt: CachePrompt): Promise<LookupResult> {
		const trace: Array<GateTrace> = [];
		/** 策略给这一条定的 TTL；`undefined` = 策略没意见，落全局默认 */
		let policyTtlMs: number | null | undefined;
		let noCacheReason: string | null = null;
		let noStoreReason: string | null = null;

		/**
		 * **`CachePolicy` 在任何一道闸之前。**它回答的不是「这条缓存还成不成立」，
		 * 而是「这个问题该不该进缓存」—— 后者一旦交给闸去拦，就要先付掉整条
		 * 召回+检索+支撑度的开销才发现不该用，而且拦不住写入。
		 *
		 * 两个开关正交，所以**判定在这里、返回在票据装配之后**：`noCache` 单独用
		 * （「重新回答」）时仍然要能写回，早退就把票据一起丢了。
		 */
		if (options.policy) {
			const disposition = await options.policy(prompt);
			noCacheReason = assertReason("noCache", disposition.noCache);
			noStoreReason = assertReason("noStore", disposition.noStore);
			policyTtlMs = disposition.ttlMs;
		}

		const { scope, shared } = await resolveScope(prompt);
		const guard = makeRedactionGuard(prompt, scope, shared);
		const { normalized, matchHash } = matchKeyOf(prompt);

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
				ttlMs: policyTtlMs,
			};
			return ticket;
		}

		/** `noStore` 生效时票据必须拒发 —— 不是「这次不写」，是写不进去 */
		const issueTicket = noStoreReason === null ? prepareWrite : bypassTicket(noStoreReason);

		function miss(exitedAt: GateId): LookupResult {
			return { outcome: "miss", payload: null, entryId: null, sourceIds: [], exitedAt, trace, wouldHave: null, noCacheReason, noStoreReason, prepareWrite: issueTicket };
		}

		// `noCache`：一道闸都不跑。trace 保持空的 —— 记成某道闸的判定就是假话
		if (noCacheReason !== null) {
			return {
				outcome: "bypass",
				payload: null,
				entryId: null,
				sourceIds: [],
				exitedAt: null,
				trace,
				wouldHave: null,
				noCacheReason,
				noStoreReason,
				prepareWrite: issueTicket,
			};
		}

		trace.push({
			gate: 1,
			name: "scope 门控",
			verdict: "pass",
			detail: `scope = ${scope}${shared ? "（共享）" : "（隔离）"}${prompt.redacted ? " · 已脱敏" : ""}`,
		});

		/* ② 精确匹配 */
		const candidate = await options.store.getByHash(scope, matchHash);
		// 哈希命中还不够：matchHash 是非密码学哈希，一次碰撞就会返回一条完全无关的
		// 答案，而这一层的全部价值在于零假命中风险。所以再比一次原文，不依赖存储实现。
		const exact = candidate && normalizeKey(candidate.matchText) === normalized ? candidate : null;
		if (exact) {
			trace.push({ gate: 2, name: "精确匹配", verdict: "hit", detail: `命中条目 ${exact.id}` });
			return verify(exact, prompt, trace, guard, issueTicket, true, { noCacheReason, noStoreReason });
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
		// ttlMs 必须一起带上 —— 这里是覆盖赋值，漏了就把 prepareWrite 记下的策略 TTL 冲掉
		ticket = { scope, shared, matchHash, matchVector, ttlMs: policyTtlMs };
		const returned = await options.store.searchNearest(scope, matchVector, recallLimit);

		/**
		 * **拿回来再复核一次 scope，不信任存储层的 pre-filter。**
		 *
		 * `searchNearest` 的契约是「只返回同 scope、未过期的条目」（见 DESIGN.md
		 * 「对存储实现的两条硬要求」），但那是**契约**，不是**校验**。② 那条路已经
		 * 用同一条规矩防住了自己（哈希命中之后再比一次原文），③ 先前没有 —— 而 ③
		 * 的失效后果严重得多：pgvector 或 Redis 那侧一个 filter 写错，就是跨 scope
		 * 返回另一门课、另一个组织的答案，而且完全静默（向量照样算得出来、相似度
		 * 照样很高、trace 上一切正常）。
		 *
		 * 这里只多一次字符串比较 —— 条目已经在手里，没有额外往返。
		 *
		 * **丢弃而不是抛。**读路径上一条脏数据不该让整个请求失败（和「缺证据不是有罪」
		 * 是同一族取舍）；但丢了多少条会如实写进 trace ——`foreign > 0` 意味着存储实现
		 * 违反了硬要求，那是个必须被人看见的缺陷，不是可以容忍的常态。
		 */
		const candidates = returned.filter(c => c.entry.scope === scope);
		const foreign = returned.length - candidates.length;
		const foreignNote = foreign > 0 ? ` · ⚠ 丢弃 ${foreign} 条 scope 不符的候选：存储层 pre-filter 失效` : "";

		if (candidates.length === 0 || candidates[0].similarity < recall.thresholds.floor) {
			const top = candidates[0]?.similarity;
			trace.push({
				gate: 3,
				name: `向量召回 top-${recallLimit}`,
				verdict: "exit",
				detail: (candidates.length === 0 ? "该 scope 下没有候选" : `最高余弦 ${top?.toFixed(4)} 低于召回下限`) + foreignNote,
				score: top,
			});
			return miss(3);
		}
		trace.push({
			gate: 3,
			name: `向量召回 top-${recallLimit}`,
			verdict: "pass",
			detail: `${candidates.length} 条候选${foreignNote}`,
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
			 * 和 ⑤ 对 plan 不适用是同一个道理，DESIGN 里已经立了这个先例。
			 *
			 * **但「不适用」在混合 scope 里等于「让位」，这一点必须说清。** 只要 top-k
			 * 里还有一条 answer，胜出者就在 answer 里挑 —— plan 条目连 ③ 排第一也拿不到
			 * 这一次复用（只有 top-k 全是 plan 时才按 ③ 的名次取 top-1）。
			 *
			 * 没有第四种选择：让 plan 拿 ③ 的余弦去跟 answer 的精排分排同一张榜，
			 * 就是这段注释开头拒绝的那种尺度混用，只不过换了个地方混。所以取舍是
			 * 「answer 优先」，代价如实写进 trace（下面的 `skipNote`）—— 混合 scope 下
			 * plan 会被 answer 饿死，用得着 plan 的调用方应当给它单独的 scope。
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
				const scored: Array<{ entry: CacheEntry; score: number; similarity: number }> = [];
				for (const c of rerankable) {
					const candidateText = target === "answer" ? c.entry.answer : c.entry.matchText;
					scored.push({
						entry: c.entry,
						score: await rerank.scorer.score(prompt.matchText, candidateText),
						similarity: c.similarity,
					});
				}
				scored.sort((a, b) => b.score - a.score);
				best = scored[0].entry;
				const questionScore = scored[0].score;
				/**
				 * **胜出者自己的 ③ 余弦，必须报出来。**
				 *
				 * ③ 的下限只卡 `candidates[0]`（那是「这批候选值不值得看」的门槛），
				 * 而这里的胜出者可以是 top-k 里任何一条 —— 包括余弦远低于 `floor` 的。
				 * 精排推翻 ③ 的名次是设计使然，但先前 trace 上只有 top-1 的余弦和精排分，
				 * 「被复用的那条 ③ 只有 0.3」这件事在哪儿都看不到。
				 *
				 * 这个项目在 `foreign > 0` 和 ⑤ 的 `would-exit` 上都守着同一条规矩：
				 * 取舍可以，但必须看得见。
				 */
				const belowFloor = scored[0].similarity < recall.thresholds.floor;
				// 中性措辞：这条闸拦下时并没有「胜出者」，只有「④ 最高分那条」
				const winnerNote =
					`；④ 最高分那条的 ③ 余弦 ${scored[0].similarity.toFixed(4)}` +
					(belowFloor ? ` **低于召回下限 ${recall.thresholds.floor}**` : "");
				const scaleNote = `${target === "answer" ? "问↔答" : "问↔问"}尺度`;
				// 「不适用」在混合 scope 里就是「让位」—— 说成「不适用」会让人以为它们还在候选里
				const skipNote = skipped === 0 ? "" : `，另有 ${skipped} 条 plan 条目本闸不适用、已让位给 answer`;
				if (questionScore < rerank.thresholds.floor) {
					trace.push({
						gate: 4,
						name: "精排",
						verdict: "exit",
						detail:
							`分数 ${questionScore.toFixed(4)} 低于闸值 ${rerank.thresholds.floor}（${scaleNote}` +
							`，标定于：${rerank.calibratedOn}）${skipNote}${winnerNote}`,
						score: questionScore,
					});
					return miss(4);
				}
				trace.push({
					gate: 4,
					name: "精排",
					verdict: "pass",
					detail:
						`过闸（${scaleNote}）${skipNote}${winnerNote}` +
						// 复用一条低于 ③ 下限的条目是 ④ 的权力，但必须写明白它用了这个权力
						(belowFloor ? "　—— 精排推翻了 ③ 的名次" : ""),
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

		return verify(best, prompt, trace, guard, issueTicket, false, { noCacheReason, noStoreReason });
	}

	/**
	 * ⑤ 资料版本比对。**被判定失效的条目在这里驱逐** —— 那是维护而不是写入：
	 * 一条版本已过期的缓存，读到它的那一刻就该消失，留着只会让下一个请求再判一次。
	 */
	async function verify(
		entry: CacheEntry,
		prompt: CachePrompt,
		trace: Array<GateTrace>,
		guard: RedactionGuard,
		prepareWrite: () => Promise<WriteTicket>,
		wasExact: boolean,
		/**
		 * 策略的两个理由原样透传。`noCache` 走不到这里（它在闸之前就返回了），
		 * 但 `noStore` 走得到 —— 一次合法的写回也要先过它。
		 */
		reasons: { readonly noCacheReason: string | null; readonly noStoreReason: string | null },
	): Promise<LookupResult> {
		// 快速失败：脱敏 × 共享 × answer 是必然出错的组合，早点抛。
		guard(entry.kind);

		/* plan 条目：不依赖语料 —— ⑤ 不适用 */
		if (entry.kind === "plan") {
			trace.push({ gate: 5, name: "资料版本比对", verdict: "off", detail: "plan 条目不依赖语料" });
			if (!shadow) await options.store.touch(entry.id);
			return {
				outcome: shadow ? "shadow" : wasExact ? "exact" : "reuse",
				wouldHave: shadow ? (wasExact ? "exact" : "reuse") : null,
				payload: payloadOf(entry),
				entryId: entry.id,
				sourceIds: [],
				exitedAt: null,
				trace,
				...reasons,
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
				detail: `版本不符（写入时 ${entry.sourceVersion} → 当前 ${currentVersion}），${shadow ? "影子模式不驱逐" : `驱逐 ${entry.id}`}`,
				// 影子模式下面那行 evict 不执行 —— 指标不能记成驱逐
				evicted: !shadow,
			});
			if (!shadow) await options.store.evict(entry.id);
			return { outcome: "miss", payload: null, entryId: null, sourceIds: [], exitedAt: 5, trace, wouldHave: null, ...reasons, prepareWrite };
		}
		trace.push({
			gate: 5,
			name: "资料版本比对",
			verdict: stale ? "would-exit" : gates.sourceVersion ? "pass" : "off",
			detail: stale ? "版本不符，但该闸已关闭 —— 过期答案会被放行" : "版本一致",
		});

		/**
		 * ⑤ 之后就是命中。**读路径到此为止，不检索。**
		 *
		 * 先前这里还有 ⑥ 回答有效性校验：拿旧答案的向量和这次检索到的 top-1 片段
		 * 算余弦，低于 θa 就驳回。它精确对应两类失效 —— 同词不同指、实体塌陷 ——
		 * 而那两类的根源都是**缓存键有损**：匿名化拿掉了实体，消歧上下文留在
		 * `context` 而不在键里。键里带全了决定答案的一切就不会有这两类，
		 * 该在键的设计和读侧条件上解决，不该在答案侧兜底。
		 *
		 * 移除它同时去掉了读路径上唯一一次 `retriever.retrieve()` 与一次 embedding。
		 */
		if (!shadow) await options.store.touch(entry.id);
		const real: LookupOutcome = wasExact ? "exact" : "reuse";
		return {
			outcome: shadow ? "shadow" : real,
			wouldHave: shadow ? real : null,
			payload: payloadOf(entry),
			entryId: entry.id,
			sourceIds: entry.sourceIds,
			exitedAt: null,
			trace,
			...reasons,
			prepareWrite,
		};
	}


	/* ------------------------------------------------------------------ *
	 * 写入
	 * ------------------------------------------------------------------ */

	/** 没有 lookup 结果可用时，现算一份写入票据。 */
	async function prepareTicket(prompt: CachePrompt): Promise<WriteTicket> {
		/**
		 * **这里也要查策略。**否则它就是绕过 `CachePolicy` 的后门：不走 `lookup`、
		 * 直接要一张票就能写进去，而那道守卫的全部意义在于「判定不缓存的东西
		 * 从类型到运行期都写不进去」。少查这一次，守卫就只是建议。
		 */
		let ttlMs: number | null | undefined;
		if (options.policy) {
			const disposition = await options.policy(prompt);
			// 只有 noStore 拦写入。noCache 说的是「别读」，不该挡住一次合法的写回
			if (disposition.noStore !== undefined) await bypassTicket(disposition.noStore)();
			ttlMs = disposition.ttlMs;
		}
		const { scope, shared } = await resolveScope(prompt);
		return {
			scope,
			shared,
			matchHash: matchKeyOf(prompt).matchHash,
			matchVector: (await recall.scorer.embedQuestions([prompt.matchText]))[0],
			ttlMs,
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
		const prepared: Array<{ scope: string; shared: boolean; matchHash: string; matchVector: ReadonlyArray<number> | null; ttlMs?: number | null }> = [];
		for (const item of items) {
			const { scope, shared } = await resolveScope(item.prompt);
			const { matchHash } = matchKeyOf(item.prompt);
			const ticket = item.options?.ticket;
			if (ticket) assertTicketMatches(ticket, item.prompt, scope, shared, matchHash);
			/**
			 * **没带票据的写入也要过一次策略。**
			 *
			 * `ticket` 是可选的（缺了就现编向量），所以「`noStore` ⇒ 拿不到票据」这道
			 * 守卫只挡住了走 `lookup` / `prepareTicket` 的那条路 —— 直接
			 * `write(prompt, payload)` 是一扇没关的正门，那句「从类型到运行期都写不进去」
			 * 就成了空话。带票据的不必重查：发票时已经查过，重查只是多付一次 policy 调用。
			 */
			let ttlMs = ticket?.ttlMs;
			if (!ticket && options.policy) {
				const disposition = await options.policy(item.prompt);
				if (disposition.noStore !== undefined) await bypassTicket(disposition.noStore)();
				ttlMs = disposition.ttlMs;
			}
			prepared.push({ scope, shared, matchHash, matchVector: ticket?.matchVector ?? null, ttlMs });
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

		/**
		 * 版本指纹按「同一组 sourceIds」去重。
		 *
		 * 批量预热与从日志回填时，整批共用一组资料是常态（同一门课的同一批大纲），
		 * 而 `SourceVersionResolver` 通常要查一次库或算一次摘要。先前每条都调一次，
		 * 30 条回填就是 30 次往返 —— 而两个向量早就各自合并成一次调用了，指纹是这条
		 * 批量路径上最后一个逐条付费的地方。
		 *
		 * **缓存只活在这一次 `writeMany` 里。**跨调用缓存会把「资料改版了」缓存住，
		 * 那正是 ⑤ 要抓的东西 —— 省一次调用换一次读不出来的失效，不值。
		 */
		const versions = new Map<string, Promise<string>>();
		function sourceVersionOf(sourceIds: ReadonlyArray<string>): Promise<string> {
			// 顺序不同就当不同的一组：指纹算法是调用方的，库不假设它与顺序无关
			const key = sourceIds.join("\u0000");
			let pending = versions.get(key);
			if (pending === undefined) {
				pending = Promise.resolve(options.sourceVersion(sourceIds));
				versions.set(key, pending);
			}
			return pending;
		}

		const written: Array<CacheEntry> = [];
		for (let i = 0; i < items.length; i++) {
			const { prompt, payload } = items[i];
			const slot = prepared[i];
			const isAnswer = payload.kind === "answer";
			const sourceIds = isAnswer ? payload.sourceIds : [];
			const created = now();
			// 显式给了 ttlMs 就用它（含 null = 不过期），其次是策略随票据带来的，最后才是全局默认
			const ttl =
				items[i].options?.ttlMs !== undefined
					? items[i].options?.ttlMs
					: slot.ttlMs !== undefined
						? slot.ttlMs
						: ttlMs;

			const entry: CacheEntry = {
				id: newId(),
				scope: slot.scope,
				kind: payload.kind,
				matchText: prompt.matchText,
				matchHash: slot.matchHash,
				matchVector: slot.matchVector ?? [],
				answer: isAnswer ? payload.answer : "",
				plan: isAnswer ? {} : payload.plan,
				sourceIds,
				sourceVersion: isAnswer ? await sourceVersionOf(sourceIds) : "",
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
	 * **收 `{ org, key }`，不收拼好的字符串。** 先前收的是 `composeScope()` 的结果，
	 * 于是漏掉组织 id 的那种写法 —— `clear("course:ml101")` —— 删掉 0 条、返回 0、
	 * 不报错，而调用方以为课程已经归档了。这正是这个库自己一路在防的静默失效，
	 * 而 README 与 `example/Smoke.ts` 里的示例当时就是这么写的：`npm run smoke`
	 * 一直在打印「删掉 0 条」，没人看出那是错的。拼接交给库之后这种写法不存在了。
	 *
	 * **必须给 scope。** 无参数的全清在生产上几乎总是误操作，真要全清就对存储调
	 * `InspectableCacheStore.clear()` —— 让它显眼一点，别藏在缓存对象的方法里。
	 */
	async function clear(scope: { readonly org: string; readonly key: string }): Promise<number> {
		// JS 调用方绕得过类型。旧签名收字符串，静默删 0 条正是要消除的那种失败
		if (typeof scope === "string") {
			throw new Error(
				`clear() 收的是 { org, key }，不是拼好的 scope 字符串（收到 ${JSON.stringify(scope)}）。` +
					"少了组织 id 的字符串只会删掉 0 条而不报错，所以拼接由库来做：clear({ org, key })。",
			);
		}
		return options.store.clearScope(composeScope(scope.org, scope.key));
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
	 * 这是「一次故障不改变缓存状态」的写入侧那一半：读路径除了 ⑤ 判出的版本失效
	 * 什么都不删，写路径拒收没有依据的产物。缺一半那条不变式就是空话。
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
	 * 一次生成失败 = 净丢一条本来还能用的缓存，而这正是「一次故障不改变缓存状态」
	 * 那条不变式要防的事（无依据的答案不写入，是同一条的另一半）。
	 *
	 * 顺序反过来之后，同 (scope, matchHash) 的两条会共存几毫秒 —— 这是安全的：
	 * `getByHash` 的契约就是取最新的那条，读到的一定是替换后的那一条。
	 */

	/**
	 * 合流键。
	 *
	 * **`retrievalText` 必须在键里。** 上游做了匿名化时，两个学生问同一句话会得到
	 * 相同的 `matchText`，但 `retrievalText` 里的实体不同 —— 检索出来的片段因此不同，
	 * 生成出来的答案也不同。只按 matchText 合流，后到的那个学生会拿到用**别人的实体**
	 * 检索、生成出来的答案。这不是命中率问题，是错答案。
	 *
	 * **解析出来的 scope 也必须在键里。** `CachePrompt` 的四个字段都在键里了，所以
	 * 只要 `ScopeResolver` 是 prompt 的纯函数，scope 就是它们的函数 —— 但那是**契约**，
	 * 不是**校验**，而这个库对 ③ 的存储层 pre-filter 用的是同一条规矩（拿回来再复核
	 * 一次 scope）。一个从请求外的环境读租户的 resolver（AsyncLocalStorage、请求头，
	 * 多租户里很常见的形状）会让两个租户的同一句话合流，**后到的租户拿到前一个租户
	 * 缓存里的答案**。写路径有票据比 scope 挡着，读命中这条路先前没有任何东西挡。
	 *
	 * 代价是每次 `resolve` 多一次 `ScopeResolver` 调用（合流判定必须在解析之后）。
	 * `writeMany` 已经为同一件事付过同一笔钱：那里也是「scope 每条都现算，带了票据
	 * 也算」，理由一样 —— 一次通常是纯函数的调用便宜，配错 scope 的后果不便宜。
	 *
	 * **分隔符只能用 `\u0000`，不能用 `=` / `&`。**先前 context 拼成 `k=v&k=v`，
	 * 于是 `{a: "b&c=d"}` 和 `{a: "b", c: "d"}` 得到同一个键 —— 两个不同的请求合流，
	 * **后到者拿到前一个请求的答案**。这不是效率问题，是错答案：教学场景里 context
	 * 装的是 courseId / userId / unit，都可能含这两个字符。
	 *
	 * 用不可能出现在文本字段里的字符，比转义省 —— 同一条规矩在 `Scope.ts` 里
	 * 因为要存进库、要人读，所以走的是转义。
	 */
	function flightKey(scope: string, prompt: CachePrompt): string {
		const context = Object.entries(prompt.context)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.flatMap(([k, v]) => [k, v]);
		return [
			scope,
			normalizeKey(prompt.matchText),
			prompt.retrievalText,
			context.join("\u0000"),
			prompt.redacted ? "1" : "0",
		].join("\u0000\u0000");
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
		// 合流之前先解析 scope —— 它必须进键，理由见 flightKey
		const { scope } = await resolveScope(prompt);
		const key = flightKey(scope, prompt);
		const running = flights.get(key);
		if (running) return running;
		const started = resolveOnce(prompt, generate, writeOptions).finally(() => flights.delete(key));
		flights.set(key, started);
		return started;
	}

	async function resolveOnce(prompt: CachePrompt, generate: Generate, writeOptions?: WriteOptions): Promise<CacheResult> {
		const found = await lookup(prompt);
		const trace: Array<GateTrace> = [...found.trace];

		/**
		 * `noCache`：没查缓存，照常生成。**写不写由 `noStore` 单独决定** ——
		 * 两个开关都设是「那第二个呢」，只设 noCache 是「重新回答」：新答案要写回去
		 * 替换旧的那条，否则每个点重来的学生都各付一次生成，而算出的更好答案全被丢掉。
		 */
		if (found.outcome === "bypass") {
			const bypassChunks = await options.retriever.retrieve(prompt.retrievalText, prompt.context);
			const produced = await generate(prompt, bypassChunks);
			// 影子模式下 bypass 也不写：一道闸都没跑，无从知道写入会不会去重顶掉一条现有条目
			const storable = !shadow && found.noStoreReason === null && cacheable(produced);
			const stored = storable ? await write(prompt, produced, { ...writeOptions, ticket: await found.prepareWrite() }) : null;
			return {
				payload: produced,
				outcome: "bypassed",
				bypassReason: found.noCacheReason,
				wouldReuse: null,
				exitedAt: null,
				// null 在这里和「答案没有依据」时同义：生成了，但没有落缓存
				entryId: stored?.id ?? null,
				sourceIds: produced.kind === "answer" ? produced.sourceIds : [],
				trace,
			};
		}

		if (found.payload && (found.outcome === "exact" || found.outcome === "reuse")) {
			return {
				payload: found.payload,
				outcome: found.outcome,
				bypassReason: null,
				// 影子模式下命中已被降级成 "shadow"，走不到这里
				wouldReuse: null,
				exitedAt: null,
				entryId: found.entryId,
				sourceIds: found.sourceIds,
				trace,
			};
		}

		/**
		 * 先前这里是**中带**：⑥ 的支撑度落在 low~high 之间时，用旧答案 + 新片段做一次
		 * 短生成（`refine`）再写回替换，写回时 `supersedes` 顶掉旧条目。中带是 ⑥ 的
		 * 产物 —— 没有支撑度就没有「不够有把握」这个状态，所以 ⑥ 移除后它、`refine`、
		 * 以及「顶替旧条目」这条写入路径一起消失：命中就是命中，未命中就是新写一条。
		 */
		// `lookup` 不再检索（⑥ 是它唯一的理由），所以生成前这一次是唯一的一次
		const chunks = await options.retriever.retrieve(prompt.retrievalText, prompt.context);
		const produced = await generate(prompt, chunks);
		/**
		 * 中带落到这里是被 ⑥ 放弃的，如实记成 6 —— 下面几条不写入的返回路径共用它，
		 * 免得同一件事在不同分支记出不同的 `exitedAt`。
		 */
		const exitedAt = found.exitedAt;

		if (!cacheable(produced)) {
			trace.push({
				gate: 5,
				name: "写入",
				verdict: "exit",
				detail: "答案没有任何资料依据，本次不写入缓存",
				// 这条 exit 在任何生成路径上都会发，连一条候选都没有的全新 scope 也会 ——
				// 反推驱逐的话，冷缓存也能报出一次「判负驱逐」
				evicted: false,
			});
			return {
				payload: produced,
				outcome: "generated",
				bypassReason: null,
				wouldReuse: shadow ? false : null,
				exitedAt,
				// null 在这里有确切含义：生成了，但没有落缓存
				entryId: null,
				sourceIds: [],
				trace,
			};
		}
		/**
		 * **影子模式的写入抑制，必须排在 `noStore` 之前。**
		 *
		 * 排后面的话，一次「本会命中但被 noStore 挡住」会落进 noStore 分支报
		 * `wouldReuse: false` —— 而 noStore 只管写不管读，它本来是会复用的，
		 * 影子模式的分子就被低估了。
		 *
		 * 抑制的范围不只是被降级的命中：**⑤⑥ 判负那两条也不能写。**
		 * `lookup` 侧的 `if (!shadow) evict` 只保住了「不主动删」，但尾巴照常生成、
		 * 照常写入，而 `writeMany` 的去重会把同 `(scope, matchHash)` 的旧条目当
		 * duplicate 驱逐 —— 从写路径把「影子模式只读」这个承诺打穿。`exitedAt` 是
		 * 5/6 正好标志「存在一条被判负但被保留的条目」；3/4 与无候选的真未命中
		 * 撞不上去重，照常写，否则缓存永远暖不起来。
		 */
		if (shadow && (found.outcome === "shadow" || exitedAt === 5)) {
			const detail =
				found.outcome === "shadow"
					? `本会 ${found.wouldHave} —— 已改为真生成，且不写回（原条目保留）`
					: `⑤⑥ 判负的条目已保留，写入也一并跳过 —— 否则去重会把它顶掉（本会 miss@${exitedAt}）`;
			trace.push({ gate: 5, name: "影子模式", verdict: "off", detail });
			return {
				payload: produced,
				outcome: "generated",
				bypassReason: null,
				wouldReuse: found.outcome === "shadow",
				exitedAt: found.outcome === "shadow" ? null : exitedAt,
				entryId: found.entryId,
				sourceIds: produced.kind === "answer" ? produced.sourceIds : [],
				trace,
			};
		}
		if (found.noStoreReason !== null) {
			trace.push({ gate: 5, name: "写入", verdict: "off", detail: `策略判定不写入（${found.noStoreReason}）—— 生成了，但不落缓存` });
			return {
				payload: produced,
				outcome: "generated",
				bypassReason: null,
				wouldReuse: shadow ? false : null,
				exitedAt,
				entryId: null,
				sourceIds: produced.kind === "answer" ? produced.sourceIds : [],
				trace,
			};
		}
		const stored = await write(prompt, produced, { ...writeOptions, ticket: await found.prepareWrite() });
		return {
			payload: produced,
			outcome: "generated",
			bypassReason: null,
			wouldReuse: shadow ? false : null,
			exitedAt,
			// 刚写进去的那条。先前这里恒为 null —— 明明写了一条却拿不到它的 id
			entryId: stored.id,
			sourceIds: produced.kind === "answer" ? produced.sourceIds : [],
			trace,
		};
	}

	return { resolve, lookup, write, writeMany, get, evict, clear, invalidateSource, purgeExpired, prepareTicket, gates, recallLimit };
}

export type SemanticCache = ReturnType<typeof createSemanticCache>;
