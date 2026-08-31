/**
 * 两个模型后端。
 *
 * MODE=local（默认）—— 真模型，跑在本地 ONNX，首次运行会下载 ~200MB。
 *   bi-encoder  : 多语种句向量，用于 ③ 召回、⑥ 回答侧校验、检索
 *   cross-encoder: 相关性重排，用于 ④
 *
 * MODE=stub —— 玩具相似度（字符 + bigram Jaccard），零下载、秒起。
 *   只用来跑通控制流和 UI。**它的分数没有任何统计意义**，不要拿 stub 模式的
 *   bench 数字去支持或反驳任何结论。
 *
 * 重排器 ms-marco-MiniLM 是英文训练的，中文上给出的分数偏弱。想认真读 ④ 的
 * 精度，把 UI 里的语料切到英文场景集，或换成 BGE_RERANKER 环境变量指定的模型。
 */

/**
 * 三个角色，三个任务，不能共用一个模型 —— 这是实测出来的：
 *
 *   PAIR_ID   问题↔问题（③ 缓存匹配、⑥ 的问题侧）→ 句对相似度模型
 *   RETR_ID   问题↔段落（检索课程资料）        → 检索模型（非对称）
 *   CE_ID     问题↔问题的精排（④）             → 句对重排器
 *
 * 一开始三个角色全用 paraphrase-multilingual-MiniLM + ms-marco，结果检索质量崩了
 * （「什么是过拟合？」检不到过拟合那一篇），重排器在中文上饱和到 0.998。
 * E5 系列是检索训练的，要求 query 前缀 "query: "、passage 前缀 "passage: "。
 */
const PAIR_ID = process.env.PAIR_MODEL || process.env.BI_MODEL || "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const RETR_ID = process.env.RETR_MODEL || "Xenova/multilingual-e5-small";
const CE_ID = process.env.CE_MODEL || "Xenova/ms-marco-MiniLM-L-6-v2";

export function cosine(a, b) {
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

export function centroid(vectors) {
	if (vectors.length === 0) return null;
	const out = new Array(vectors[0].length).fill(0);
	for (const v of vectors) for (let i = 0; i < v.length; i++) out[i] += v[i];
	for (let i = 0; i < out.length; i++) out[i] /= vectors.length;
	return out;
}

/* ---------- stub 后端 ---------- */

function grams(text) {
	const s = text.toLowerCase().replace(/\s+/g, "");
	const set = new Set(s.split(""));
	for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
	return set;
}

function jaccard(a, b) {
	let inter = 0;
	for (const g of a) if (b.has(g)) inter++;
	return inter === 0 ? 0 : inter / (a.size + b.size - inter);
}

/**
 * stub 的「向量」是 gram 集合的稀疏投影：把每个 gram 哈希到固定维度。
 * 这样 cosine() 仍然可用，⑥ 的重心运算也不用特判。
 */
function stubEmbed(text, dim = 256) {
	const v = new Array(dim).fill(0);
	for (const g of grams(text)) {
		let h = 0;
		for (let i = 0; i < g.length; i++) h = (h * 31 + g.charCodeAt(i)) >>> 0;
		v[h % dim] += 1;
	}
	return v;
}

/* ---------- 工厂 ---------- */

export async function createEncoder() {
	const wanted = process.env.MODE || "local";

	if (wanted === "stub") {
		return {
			mode: "stub",
			rerankAvailable: false,
			retrievalModel: "stub",
			note: "玩具相似度，仅供跑通流程；分数无统计意义",
			async embed(texts) {
				return texts.map(t => stubEmbed(t));
			},
			async embedQuery(texts) {
				return texts.map(t => stubEmbed(t));
			},
			async embedPassage(texts) {
				return texts.map(t => stubEmbed(t));
			},
			async rerank() {
				return null;
			},
		};
	}

	try {
		const { AutoModelForSequenceClassification, AutoTokenizer, pipeline } = await import("@huggingface/transformers");

		process.stdout.write(`加载句对模型 ${PAIR_ID} …\n`);
		const pairEx = await pipeline("feature-extraction", PAIR_ID);

		// 检索模型单独加载；拿不到就退回句对模型，并在 note 里说明（那时检索质量会很差）
		let retrEx = null;
		let retrOk = false;
		try {
			process.stdout.write(`加载检索模型 ${RETR_ID} …\n`);
			retrEx = await pipeline("feature-extraction", RETR_ID);
			retrOk = true;
		} catch (err) {
			process.stdout.write(`检索模型加载失败，退回句对模型（检索质量会明显变差）：${err.message}\n`);
			retrEx = pairEx;
		}
		const e5 = retrOk && /e5/i.test(RETR_ID);

		let ceTok = null;
		let ceModel = null;
		try {
			process.stdout.write(`加载 cross-encoder ${CE_ID} …\n`);
			ceTok = await AutoTokenizer.from_pretrained(CE_ID);
			ceModel = await AutoModelForSequenceClassification.from_pretrained(CE_ID);
		} catch (err) {
			process.stdout.write(`cross-encoder 加载失败，④ 将被跳过：${err.message}\n`);
		}

		return {
			mode: "local",
			rerankAvailable: ceModel !== null,
			retrievalModel: retrOk ? RETR_ID : `${PAIR_ID}（回退）`,
			note: `句对 ${PAIR_ID} | 检索 ${retrOk ? RETR_ID : PAIR_ID + "（回退）"} | 重排 ${ceModel ? CE_ID : "无"}`,
			// 问题↔问题
			async embed(texts) {
				const out = await pairEx(texts, { pooling: "mean", normalize: true });
				return out.tolist();
			},
			async embedQuery(texts) {
				const out = await retrEx(e5 ? texts.map(t => `query: ${t}`) : texts, { pooling: "mean", normalize: true });
				return out.tolist();
			},
			async embedPassage(texts) {
				const out = await retrEx(e5 ? texts.map(t => `passage: ${t}`) : texts, { pooling: "mean", normalize: true });
				return out.tolist();
			},
			async rerank(a, b) {
				if (!ceModel) return null;
				const inputs = await ceTok(a, { text_pair: b, padding: true, truncation: true });
				const { logits } = await ceModel(inputs);
				const raw = Number(logits.data[0]);
				return 1 / (1 + Math.exp(-raw)); // sigmoid → 0..1
			},
		};
	} catch (err) {
		process.stdout.write(`本地模型不可用，回退 stub 模式：${err.message}\n`);
		process.env.MODE = "stub";
		return createEncoder();
	}
}
