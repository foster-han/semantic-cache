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
	/**
	 * 三个角色各自用的是哪个模型。**结构化给出，不让页面去解析 `note`。**
	 * 这三行是「现在跑的到底是什么」的一半答案（另一半是存储与生成端），
	 * 页面顶部要逐行显示 —— 任务错配这类事，只有把三个角色摊开才看得见。
	 */
	readonly models: {
		readonly pair: string;
		readonly retrieval: string;
		/** 没加载到重排器时为 null —— 那就是没有 ④ 这道闸 */
		readonly rerank: string | null;
	};
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
		models: { pair: "stub", retrieval: "stub", rerank: null },
		embedQuestions: embed,
		embedQuery: embed,
		embedPassage: embed,
		async rerank() {
			return null;
		},
	};
}

/* ---------- 工厂 ---------- */

/**
 * 降级要不要允许。**默认不允许。**
 *
 * 隔壁 `Generators.ts` 对同一个问题的处置是对的：「生成失败直接抛错，不退回 stub ——
 * 两种分布混着标出来的 θa 比标不准更糟」。这里先前是反的：检索模型加载失败就退回句对
 * 模型（正是「什么是过拟合 top-1 是批归一化」那次任务错配的配置），任何异常则整体退回
 * stub —— `MODE=local` 却跑着玩具相似度，只在启动日志里留一行。两条都是静默降级，
 * 而 FINDINGS 坑 #5 说的就是这件事。
 *
 * 真要在没有网络/模型的机器上跑通控制流，用 `MODE=stub` 显式说出来；
 * 或者 `ALLOW_ENCODER_FALLBACK=1` 显式承担后果。
 */
const ALLOW_FALLBACK = process.env.ALLOW_ENCODER_FALLBACK === "1";

/** 自己抛的装配错误，好让外层那个兜底 catch 认出来别再包一层 */
class EncoderSetupError extends Error {}

function fallbackOrThrow(what: string, err: unknown, consequence: string): void {
	if (err instanceof EncoderSetupError) throw err;
	const detail = `${what}：${String(err)}`;
	if (!ALLOW_FALLBACK) {
		throw new EncoderSetupError(
			`${detail}\n${consequence}\n` +
				"这里不静默降级 —— 降级之后跑出来的分数是另一个分布上的产物，比跑不起来更难发现。" +
				"要玩具相似度请显式 MODE=stub；确实想降级请 ALLOW_ENCODER_FALLBACK=1。",
		);
	}
	process.stdout.write(`⚠ ${detail}\n⚠ ${consequence}（ALLOW_ENCODER_FALLBACK=1，已按你的要求继续）\n`);
}

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
			fallbackOrThrow(
				`检索模型 ${RETR_ID} 加载失败`,
				err,
				"退回句对模型做检索 = 任务错配：实测「什么是过拟合？」的 top-1 会变成「批归一化」（0.366），而程序一路不报错",
			);
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

		/**
		 * cross-encoder 的分数。
		 *
		 * **必须看 logits 有几路。** 先前无条件取 `data[0]` 过 sigmoid：`ms-marco` 是
		 * 单 logit 所以对，但 DESIGN 建议你换的那类「句对 / 重复问题」模型里有两分类的
		 * （`[不相关, 相关]`），此时 `data[0]` 是**不相关**那一路 —— 分数方向整个反过来，
		 * 而且不报错：模型正常加载、返回合法的 0~1、程序跑完。这正是这套东西一路在防的
		 * 静默失效，所以两路走 softmax、其它路数直接抛。
		 */
		async function rerank(a: string, b: string): Promise<number | null> {
			if (!ceModel || !ceTok) return null;
			const inputs = await ceTok(a, { text_pair: b, padding: true, truncation: true });
			const { logits } = await ceModel(inputs);
			const values = Array.from(logits.data as ArrayLike<number>, Number);
			// dims 形如 [batch, labels]；只喂了一对，所以最后一维就是路数
			const dims = logits.dims as ReadonlyArray<number>;
			const labels = dims.length > 0 ? dims[dims.length - 1] : values.length;
			if (labels === 1) return 1 / (1 + Math.exp(-values[0]));
			if (labels === 2) {
				// softmax 的正类。减去 max 只为数值稳定
				const top = Math.max(values[0], values[1]);
				const a0 = Math.exp(values[0] - top);
				const a1 = Math.exp(values[1] - top);
				return a1 / (a0 + a1);
			}
			throw new Error(
				`cross-encoder ${CE_ID} 输出 ${labels} 路 logits（dims ${JSON.stringify(dims)}），不知道哪一路是「相关」。` +
					"单 logit 走 sigmoid、两分类走 softmax 取正类，其它情况必须由你明确指定 —— " +
					"猜错的后果是分数方向反过来，而且一路不报错。",
			);
		}

		return {
			mode: "local",
			rerankAvailable: ceModel !== null,
			retrievalModel: retrOk ? RETR_ID : `${PAIR_ID}（回退）`,
			note: `句对 ${PAIR_ID} | 检索 ${retrOk ? RETR_ID : `${PAIR_ID}（回退）`} | 重排 ${ceModel ? CE_ID : "无"}`,
			models: {
				pair: PAIR_ID,
				retrieval: retrOk ? RETR_ID : `${PAIR_ID}（⚠ 回退，任务错配）`,
				rerank: ceModel ? CE_ID : null,
			},
			embedQuestions: texts => run(pairEx, texts, ""),
			embedQuery: texts => run(retrEx, texts, usesE5Prefix ? "query: " : ""),
			embedPassage: texts => run(retrEx, texts, usesE5Prefix ? "passage: " : ""),
			rerank,
			reranker: ceModel ? { score: async (q, c) => (await rerank(q, c)) ?? 0 } : undefined,
		};
	} catch (err) {
		fallbackOrThrow(
			"本地模型不可用",
			err,
			"MODE=local 却跑 stub 的玩具相似度（字符 Jaccard 的哈希投影），分数没有统计意义",
		);
		return stubEncoders();
	}
}
