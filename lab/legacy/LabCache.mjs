/**
 * 把验证台接到 SDK 上。
 *
 * 重构前这里有一套和 SDK 重复的六道闸实现（pipeline.mjs）。那种状态下 SDK
 * 等于没被验证过 —— 现在判定逻辑只有一份，跑验证台就是在跑 SDK。
 *
 * 验证台特有的东西留在这里：语料与版本、检索（含个人数据源）、答案拼装、
 * 匿名化，以及那几个用来做对照实验的开关。
 */
import { compare, createMemoryCacheStore, createSemanticCache, evaluate } from "../sdk/src/index.ts";
import { COURSE, DISTRACTORS, DOCS, ENTITIES, SCENARIOS, STUDENT_RECORDS, SYL_V2 } from "./corpus.mjs";

export const DEFAULTS = {
	gate1: false, // ① 检出实体就强制 user scope
	// 上层是否**如实声明**已脱敏。声明了，SDK 会直接拒绝把它放进共享 scope ——
	// 塌陷从根上不可能被配置出来。不声明（现实中最常见的失误：忘了）就得靠 ⑥ 兜底。
	declareRedacted: false,
	gate4: true, // ④ 精排
	gate5: true, // ⑤ 资料版本比对
	gate6: true, // ⑥ 回答有效性校验
	preAnonRetrieval: true, // ⑥ 的检索用保留实体的原文
	scopeMode: "course", // course（全班共享）| unit（再按当前章节切）
	thetaQ: 0.55,
	recallFloor: 0.45,
	thetaAHi: 0.97,
	thetaALo: 0.96,
	topK: 5,
	chunkK: 3,
	chunkCut: 0.85,
	unitBoost: 0.92,
};

/** 方案 A 的匿名化：按出现顺序编号，两个不同的人都会变成 <PERSON_1>。 */
export function anonymize(text) {
	let out = text;
	let n = 0;
	const found = [];
	for (const e of ENTITIES) {
		if (out.includes(e)) {
			n += 1;
			found.push({ token: `<PERSON_${n}>`, value: e });
			out = out.split(e).join(`<PERSON_${n}>`);
		}
	}
	return { text: out, found };
}

function cos(a, b) {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const d = Math.sqrt(na) * Math.sqrt(nb);
	return d === 0 ? 0 : dot / d;
}

export function createLab(encoder) {
	let docs = DOCS.map(d => ({ ...d }));
	const store = createMemoryCacheStore();
	let counters = fresh();
	let lastTrace = [];

	function fresh() {
		return { ask: 0, exact: 0, reuse: 0, refine: 0, generated: 0 };
	}

	/** 指纹只覆盖这条缓存实际引用过的资料 —— 引用资料级，不是课程级。 */
	function fingerprint(ids) {
		return ids
			.map(id => {
				if (id.startsWith("rec:")) return `${id}v1`;
				const d = docs.find(x => x.id === id);
				return d ? `${d.id}v${d.version}` : `${id}v?`;
			})
			.join(",");
	}

	/**
	 * 课程内检索。两处贴近真实产品的偏离：
	 *  - 章节加权：产品知道学生当前学到第几章
	 *  - 个人数据源：只能靠实体名字命中，检索够不到 —— 匿名化正好毁掉这条路
	 */
	async function retrieveChunks(text, unit, cfg) {
		const pool = docs.filter(d => d.course === COURSE).map(d => ({ ...d }));
		for (const [name, rec] of Object.entries(STUDENT_RECORDS)) {
			if (text.includes(name)) {
				pool.push({ id: `rec:${name}`, course: COURSE, unit: "个人数据", title: `${name}`, version: 1, text: rec });
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
				score: cos(qv, dv[i]) * (unit && d.unit !== unit && d.unit !== "个人数据" ? cfg.unitBoost : 1),
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, cfg.chunkK);
		const cut = ranked[0].score * cfg.chunkCut;
		return ranked.filter(r => r.score >= cut);
	}

	/**
	 * 拼答案。已知的方法学缺陷：真实答案是 LLM 改写过的，这里只换序换壳，
	 * 所以 ⑥ 的支撑度天然偏高，能读的是相对差值不是绝对阈值。
	 */
	function compose(chunks) {
		if (chunks.length === 0) return "（本课程下没有可用资料）";
		const top = chunks[0];
		const sentences = String(top.text).split(/(?<=[。.])/u).filter(Boolean);
		const lead = sentences[0] ?? top.text;
		const rest = sentences.slice(1).join("");
		const also = chunks[1] ? `\n\n另外可以对照《${chunks[1].title}》一起看。` : "";
		return `简单说：${lead}${rest ? `\n\n展开一点：${rest}` : ""}${also}\n\n（依据：《${top.title}》v${top.version}）`;
	}

	// kind 是必填的 —— 少了它 SDK 会把这条当成 plan 处理（sourceIds 落空）。
	// 验证台是 .mjs，这个契约变更不会在编译期报错，所以踩过一次。
	const generate = async (_request, chunks) => ({
		kind: "answer",
		answer: compose(chunks),
		sourceIds: chunks.map(c => c.id),
	});

	const refine = async (cachedAnswer, _request, chunks) => ({
		kind: "answer",
		answer: `${cachedAnswer}\n（已按本次检索到的《${chunks[0]?.title ?? "—"}》微调）`,
		sourceIds: chunks.map(c => c.id),
	});

	/** 按一组开关组装一个 SDK 实例。开关就是靠这里翻译成 SDK 的配置的。 */
	function build(cfg) {
		return createSemanticCache({
			encoders: {
				pair: { embedQuestions: t => encoder.embed(t) },
				retrieval: { embedQuery: t => encoder.embedQuery(t), embedPassage: t => encoder.embedPassage(t) },
				// 关掉 ④ 就是不传 reranker —— SDK 会退化为对召回余弦取闸
				rerank: cfg.gate4 && encoder.rerankAvailable ? { score: (q, c) => encoder.rerank(q, c) } : undefined,
			},
			store,
			retriever: { retrieve: (text, ctx) => retrieveChunks(text, ctx.unit || null, cfg) },
			// ① PII 门控就写在 scope 解析里 —— SDK 不关心 PII，只认 scope 字符串
			// 返回 { key, shared } 让 SDK 知道这是不是共享 scope。
			// 只返回字符串会被保守地当作共享。
			scope: request => {
				if (cfg.gate1 && request.context.pii === "1") {
					return { key: `user:${request.context.userId}`, shared: false };
				}
				const key =
					cfg.scopeMode === "unit" ? `course:${COURSE}|unit:${request.context.unit || "-"}` : `course:${COURSE}`;
				return { key, shared: true };
			},
			sourceVersion: ids => fingerprint(ids),
			refine,
			thresholds: {
				recallFloor: cfg.recallFloor,
				rerankFloor: cfg.thetaQ,
				supportHigh: cfg.thetaAHi,
				supportLow: cfg.thetaALo,
			},
			gates: { rerank: cfg.gate4, sourceVersion: cfg.gate5, answerCheck: cfg.gate6 },
			recallLimit: cfg.topK,
			ttlMs: null,
		});
	}

	/** 把验证台的一次提问翻译成 SDK 的 CacheRequest。 */
	function toRequest(input, cfg) {
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
			// 仅供 UI 展示，SDK 不看
			display: { original: input.text, anonymized: anon.text, entities: anon.found },
		};
	}

	async function ask(input, override) {
		const cfg = { ...DEFAULTS, ...override };
		counters.ask += 1;
		const request = toRequest(input, cfg);
		const result = await build(cfg).resolve(request, generate);
		counters[result.outcome] = (counters[result.outcome] ?? 0) + 1;
		lastTrace = result.trace;
		return { ...result, request };
	}

	return {
		ask,
		defaults: DEFAULTS,
		get docs() {
			return docs;
		},
		get cache() {
			return store.all();
		},
		get counters() {
			return counters;
		},
		get lastTrace() {
			return lastTrace;
		},
		bumpCorpus() {
			docs = docs.map(d => (d.id === "syl" ? { ...d, version: 2, text: SYL_V2 } : d));
			return fingerprint(["syl"]);
		},
		reset() {
			docs = DOCS.map(d => ({ ...d }));
			store.clear();
			counters = fresh();
			lastTrace = [];
		},
		/** 灌干扰缓存，让 ③ 的 top-k 真的有东西可排。 */
		async warm(cfg) {
			for (const t of DISTRACTORS) await ask({ text: t, user: "warm" }, cfg);
			return store.all().length;
		},

		/**
		 * 场景集回归。判据用 SDK 的 evaluate ——「答案的首要依据是不是那篇资料」，
		 * 不是「有没有复用」。命中另一条内容正确的缓存也算成功。
		 */
		async bench(override) {
			const cfg = { ...DEFAULTS, ...override };
			const cache = build(cfg);
			const scenarios = SCENARIOS.map(s => ({
				key: s.key,
				label: s.label,
				expectSourceId: s.expectDoc,
				seed: toRequest(s.seed, cfg),
				probe: toRequest(s.probe, cfg),
				between: s.bumpCorpus ? async () => void this.bumpCorpus() : undefined,
			}));
			let report;
			try {
				report = await evaluate(cache, scenarios, generate, {
				reset: async () => {
					docs = DOCS.map(d => ({ ...d }));
					store.clear();
				},
				warm: async (c, g) => {
					for (const t of DISTRACTORS) await c.resolve(toRequest({ text: t, user: "warm" }, cfg), g);
				},
				});
			} catch (err) {
				this.reset();
				// SDK 拒绝了这个配置 —— 这本身就是有效结果，如实报出来
				return { rejected: true, reason: String(err?.message ?? err), rows: [], total: 0, falseHit: 0, missed: 0 };
			}
			this.reset();
			const byKey = new Map(SCENARIOS.map(s => [s.key, s]));
			return {
				rows: report.rows.map(r => ({
					...r,
					note: byKey.get(r.key)?.note ?? "",
					caveat: byKey.get(r.key)?.caveat ?? null,
					got: r.outcome === "generated" ? "regenerate" : "reuse",
					basedOn: r.actualSourceIds,
					expectDoc: r.expectSourceId,
					exitedAt: r.exitedAt,
				})),
				total: report.total,
				falseHit: report.falseHits,
				missed: report.total - report.passed - report.falseHits,
			};
		},
	};
}
