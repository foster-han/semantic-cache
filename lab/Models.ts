/**
 * 三个模型角色的实现。**它们比的不是同一类东西，不能共用一个模型。**
 *
 * 实测两次任务错配，都不报错：
 *   - 拿句对模型做检索：「什么是过拟合？」top-1 是批归一化（0.366）→ 换检索模型后 0.888
 *   - 拿段落重排器比问题↔问题：中文四组难度递减的输入全落在 0.9975–0.9988，跨度 0.0013
 *
 * MODE=stub 是零依赖的玩具相似度，只用来跑通控制流；**分数没有统计意义**。
 */
import type { PairEncoder, Reranker, RetrievalEncoder } from "../sdk/src/index.ts";

const PAIR_ID = process.env.PAIR_MODEL ?? "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const RETR_ID = process.env.RETR_MODEL ?? "Xenova/multilingual-e5-small";
const CE_ID = process.env.CE_MODEL ?? "Xenova/ms-marco-MiniLM-L-6-v2";

export interface LabEncoders extends PairEncoder, RetrievalEncoder {
	readonly mode: "stub" | "local";
	readonly note: string;
	readonly rerankAvailable: boolean;
	readonly retrievalModel: string;
	/** 无重排器时返回 null */
	rerank(a: string, b: string): Promise<number | null>;
	/** 供 SDK 使用的重排器接口；无重排器时为 undefined */
	readonly reranker?: Reranker;
}

export function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
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

/* ---------- stub ---------- */

function grams(text: string): Set<string> {
	const s = text.toLowerCase().replace(/\s+/gu, "");
	const set = new Set<string>(s.split(""));
	for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
	return set;
}

function stubEmbed(text: string, dim = 256): Array<number> {
	const v = new Array<number>(dim).fill(0);
	for (const g of grams(text)) {
		let h = 0;
		for (let i = 0; i < g.length; i++) h = (h * 31 + g.charCodeAt(i)) >>> 0;
		v[h % dim] += 1;
	}
	return v;
}

function stubEncoders(): LabEncoders {
	const embed = async (texts: ReadonlyArray<string>) => texts.map(t => stubEmbed(t));
	return {
		mode: "stub",
		note: "玩具相似度，仅供跑通流程；分数无统计意义",
		rerankAvailable: false,
		retrievalModel: "stub",
		embedQuestions: embed,
		embedQuery: embed,
		embedPassage: embed,
		async rerank() {
			return null;
		},
	};
}

/* ---------- 工厂 ---------- */

export async function createEncoders(): Promise<LabEncoders> {
	if ((process.env.MODE ?? "local") === "stub") return stubEncoders();

	try {
		const { AutoModelForSequenceClassification, AutoTokenizer, pipeline } = await import("@huggingface/transformers");

		process.stdout.write(`加载句对模型 ${PAIR_ID} …\n`);
		const pairEx = await pipeline("feature-extraction", PAIR_ID);

		let retrEx = pairEx;
		let retrOk = false;
		try {
			process.stdout.write(`加载检索模型 ${RETR_ID} …\n`);
			retrEx = await pipeline("feature-extraction", RETR_ID);
			retrOk = true;
		} catch (err) {
			process.stdout.write(`检索模型加载失败，退回句对模型（检索质量会明显变差）：${String(err)}\n`);
		}
		const usesE5Prefix = retrOk && /e5/iu.test(RETR_ID);

		let ceTok: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
		let ceModel: Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>> | null = null;
		try {
			process.stdout.write(`加载 cross-encoder ${CE_ID} …\n`);
			ceTok = await AutoTokenizer.from_pretrained(CE_ID);
			ceModel = await AutoModelForSequenceClassification.from_pretrained(CE_ID);
		} catch (err) {
			process.stdout.write(`cross-encoder 加载失败，④ 将被跳过：${String(err)}\n`);
		}

		async function run(
			extractor: typeof pairEx,
			texts: ReadonlyArray<string>,
			prefix: string,
		): Promise<Array<Array<number>>> {
			const input = prefix ? texts.map(t => `${prefix}${t}`) : [...texts];
			const out = await extractor(input, { pooling: "mean", normalize: true });
			return out.tolist() as Array<Array<number>>;
		}

		async function rerank(a: string, b: string): Promise<number | null> {
			if (!ceModel || !ceTok) return null;
			const inputs = await ceTok(a, { text_pair: b, padding: true, truncation: true });
			const { logits } = await ceModel(inputs);
			const raw = Number(logits.data[0]);
			return 1 / (1 + Math.exp(-raw));
		}

		return {
			mode: "local",
			rerankAvailable: ceModel !== null,
			retrievalModel: retrOk ? RETR_ID : `${PAIR_ID}（回退）`,
			note: `句对 ${PAIR_ID} | 检索 ${retrOk ? RETR_ID : `${PAIR_ID}（回退）`} | 重排 ${ceModel ? CE_ID : "无"}`,
			embedQuestions: texts => run(pairEx, texts, ""),
			embedQuery: texts => run(retrEx, texts, usesE5Prefix ? "query: " : ""),
			embedPassage: texts => run(retrEx, texts, usesE5Prefix ? "passage: " : ""),
			rerank,
			reranker: ceModel ? { score: async (q, c) => (await rerank(q, c)) ?? 0 } : undefined,
		};
	} catch (err) {
		process.stdout.write(`本地模型不可用，回退 stub 模式：${String(err)}\n`);
		return stubEncoders();
	}
}
