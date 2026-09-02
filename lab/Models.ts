/**
 * 三个模型角色的实现。**它们比的不是同一类东西，不能共用一个模型。**
 *
 * 实测两次任务错配，都不报错：
 *   - 拿句对模型做检索：「什么是过拟合？」top-1 是批归一化（0.366）→ 换检索模型后 0.888
 *   - 拿段落重排器比问题↔问题：中文四组难度递减的输入全落在 0.9975–0.9988，跨度 0.0013
 *
 * MODE=stub 是零依赖的玩具相似度，只用来跑通控制流；**分数没有统计意义**。
 */
import type { PairEncoder, Reranker, RerankTarget } from "../sdk/src/index.ts";

/**
 * 问题 ↔ 段落（非对称）。**这是验证台自己那个玩具 RAG 的编码器，不是缓存的角色。**
 *
 * 先前它是 SDK 的 `RetrievalEncoder`，供 ⑥ 回答有效性校验使用。⑥ 移除后 SDK 不再有
 * 这个角色 —— 库不实现检索，`Retriever` 由调用方传入。验证台恰好就是那个调用方，
 * 没有真 RAG 可接，所以自己留一份：查询侧与文档侧分开（E5 一类要 `query:`/`passage:`
 * 前缀），两侧必须落在同一个向量空间。
 */
export interface LabRetrievalEncoder {
	embedQuery(texts: ReadonlyArray<string>): Promise<Array<Array<number>>>;
	embedPassage(texts: ReadonlyArray<string>): Promise<Array<Array<number>>>;
}

/**
 * 默认语料是英文（`Corpus.ts`），所以默认编码器也是英文的。
 *
 * 先前两个默认都是多语模型，各约 118M —— 其中约 96M 是 25 万词的多语词表，
 * Transformer 本体只有约 21M。纯英文场景下那份词表是白付的下载量。
 * 换成英文模型后本体算力不变、维度同样是 384（**已存的向量不用迁移**），体积小一个量级。
 *
 * 检索侧特意留在 e5 家族：下面 `usesE5Prefix` 是按模型名里有没有 `e5` 判的，
 * 换到 bge 那类会静默丢掉 query/passage 前缀 —— 又是一次不报错的任务错配。
 *
 * 跑中文请一并回切：`CORPUS_LANG=zh PAIR_MODEL=Xenova/paraphrase-multilingual-MiniLM-L12-v2
 * RETR_MODEL=Xenova/multilingual-e5-small`。
 */
const PAIR_ID = process.env.PAIR_MODEL ?? "Xenova/all-MiniLM-L6-v2";
const RETR_ID = process.env.RETR_MODEL ?? "Xenova/e5-small-v2";
const CE_ID = process.env.CE_MODEL ?? "Xenova/ms-marco-MiniLM-L-6-v2";

/**
 * ④ 把旧问题还是旧答案递给重排器。**默认仍是 `question`，因为默认没有 ④。**
 *
 * 实测问↔答明显更好（同一个 bge-reranker-base，留一交叉验证 27.8% 对 50%，且假负归零），
 * 但那需要 `CE_MODEL=Xenova/bge-reranker-base` 一起换 —— 默认的 ms-marco 在中文上
 * 两种形态都饱和，标定表里两种形态都没有它的行，所以中文默认 ④ 是关的。
 * 把默认形态改成 answer 只会让英文那行已标定的 θq（ms-marco × 问↔问 = 0.979）失配，
 * 白白关掉一道在英文上确实标定过的闸。要跑新配置：
 *
 *   CE_MODEL=Xenova/bge-reranker-base CE_TARGET=answer npm start
 */
if (process.env.CE_TARGET !== undefined && process.env.CE_TARGET !== "answer" && process.env.CE_TARGET !== "question") {
	throw new Error(
		`CE_TARGET=${process.env.CE_TARGET} 无效，只能是 question 或 answer。` +
			"它决定 ④ 把旧问题还是旧答案递给重排器 —— 两者尺度不同，θq 不通用，所以不给它一个「差不多」的解释。",
	);
}

const CE_TARGET: RerankTarget = process.env.CE_TARGET === "answer" ? "answer" : "question";

/**
 * 每个 embedding 模型的 pooling 模式。**这不是可以取默认值的东西。**
 *
 * 先前 `run()` 一律传 `pooling: "mean"`。实测代价：`redis/langcache-embed-v1` 的
 * `1_Pooling/config.json` 写着 `pooling_mode_cls_token: true`，拿 mean 去跑它，
 * 1000 对 QQP 上「正命中率 ≥ 97% 时的命中率」从 60.0% 掉到 54.8%（≥95% 时 89.0% → 76.6%）——
 * （这两个绝对值是 in-domain 的，该模型就在 QQP 上微调过；但这里要的是**同模型同数据下
 * 换 pooling 的差**，那个比较不受影响）——
 * **少一成多的命中率，而且不报错**。这和「三个模型角色不能共用」是同一类问题：
 * 模型的元数据靠猜，猜错了没人告诉你。
 *
 * 表里只放**查过出处**的。查法：读模型仓库的 `1_Pooling/config.json`。
 * **「查过」是指逐个仓库查过，不是查过一个就按系列推广** —— 先前那条
 * `/gte-|bge-(?!reranker)/ → cls` 就是这么错的，见下面 gte 两行。
 */
const POOLING_BY_MODEL: ReadonlyArray<readonly [RegExp, "mean" | "cls", string]> = [
	// 读过 1_Pooling/config.json：pooling_mode_cls_token=true
	[/^redis\/langcache-embed/u, "cls", "读过 1_Pooling/config.json"],
	// 读过 bge-small/base/large-en-v1.5 与 bge-m3 的 1_Pooling：都是 cls。reranker 不是 embedding，排除
	[/bge-(?!reranker)/u, "cls", "读过 1_Pooling/config.json：bge embedding 用 [CLS]"],
	/**
	 * **gte 分两代，pooling 相反，一条 `gte-` 盖不住。**
	 *
	 * 逐个读过 1_Pooling/config.json：thenlper 的 gte-small/base/large 是
	 * `pooling_mode_mean_tokens`，Alibaba-NLP 的 gte-*-en-v1.5 与 gte-multilingual-base
	 * 才是 `pooling_mode_cls_token`。先前一条 `/gte-/ → cls` 把前一代也判成了 cls ——
	 * 实测 `RETR_MODEL=Xenova/gte-small` 在本语料检索上 top-1 从 92.3% 掉到 80.8%
	 * （26 题里的 3 题，量级别当准数；方向是确定的，见 _probe_retrievalEncoders.ts）。
	 *
	 * **它比没有规则更坏**：落到回落分支至少会打一行警告，而这条会打着
	 * 「gte / bge embedding 官方用 [CLS]」的理由自信地配错。所以两代各写一行，
	 * 两代都不匹配的 gte 变体宁可落到警告，也不替它猜。
	 */
	[/^Alibaba-NLP\/gte-|gte-[a-z-]*v1\.5/u, "cls", "读过 1_Pooling/config.json：gte 的 v1.5 一代用 [CLS]"],
	[/gte-(?:small|base|large)$/u, "mean", "读过 1_Pooling/config.json：thenlper 那一代 gte 用 mean"],
	// 读过 arctic-embed 的 xs/s/m/l 与 m-v2.0 的 1_Pooling：整个系列都是 cls
	[/snowflake-arctic-embed-/u, "cls", "读过 1_Pooling/config.json：arctic-embed 用 [CLS]"],
	// E5 官方 README 明确 average pooling
	[/e5-/u, "mean", "E5 官方用 average pooling"],
	// 读过 nomic-embed-text v1 与 v1.5 的 1_Pooling：都是 mean
	[/nomic-embed-text-v1(?:\.5)?$/u, "mean", "读过 1_Pooling/config.json：nomic-embed-text 用 mean"],
	// 读过 jina-embeddings-v2 的 small-en 与 base-en 的 1_Pooling：都是 mean。v3 没查过，不替它猜
	[/jina-embeddings-v2-(?:small|base)-en$/u, "mean", "读过 1_Pooling/config.json：jina v2 用 mean"],
	/**
	 * `PAIR_MODEL` 的默认值自己不在表里，于是**默认配置每次启动都在喊「这可能是错的」**。
	 * 回落撞对了（读过 1_Pooling：all-MiniLM-L6-v2 与 L12-v2 都是 mean），但一行天天响的
	 * 警告会被训练成噪音，等它真为某个未知模型响起时就没人看了。写进表里让它闭嘴。
	 */
	[/all-MiniLM-L(?:6|12)-v2/u, "mean", "读过 1_Pooling/config.json：all-MiniLM 用 mean"],
	// sentence-transformers 的 paraphrase-* 系列是 mean
	[/paraphrase-/u, "mean", "sentence-transformers paraphrase-* 为 mean"],
];

type Pooling = "mean" | "cls";

/**
 * 取值合法性在**模块顶层**查，不等 `poolingFor` 被调到。
 *
 * `poolingFor` 是在两个 extractor 都加载完之后才调用的，把校验留在那里等于
 * 一个拼错的环境变量要先付掉一次 600MB 下载 + 两次模型加载才报错。
 * sdk 那边同一条规矩写成了测试：「守卫跑在任何编码之前 —— 别先付掉一整批 embedding 再抛」。
 */
for (const name of ["PAIR_POOLING", "RETR_POOLING"] as const) {
	const v = process.env[name];
	if (v !== undefined && v !== "" && v !== "mean" && v !== "cls") {
		throw new Error(
			`${name}=${v} 无效，只能是 mean 或 cls。它决定句向量怎么从 token 向量聚合 —— ` +
				"配错不报错，只会给出判别力差一档的向量（实测少一成多的命中率）。",
		);
	}
}

/**
 * 定这个模型该用哪种 pooling。顺序：环境变量 > 已知表 > **mean 加警告**。
 *
 * 落到最后一档时会打一行警告而不是默默用 mean —— 那正是 FINDINGS 坑 #5
 * 「静默降级比跑不起来更难发现」说的事。
 */
function poolingFor(id: string, override: string | undefined, role: string): Pooling {
	if (override === "cls" || override === "mean") {
		process.stdout.write(`${role} pooling=${override}（由环境变量指定）\n`);
		return override;
	}
	// 非法值已在模块顶层拦掉，这里只剩「没设」这一种情况
	for (const [pattern, mode, why] of POOLING_BY_MODEL) {
		if (pattern.test(id)) {
			process.stdout.write(`${role} pooling=${mode}（${why}）\n`);
			return mode;
		}
	}
	process.stdout.write(
		`⚠ ${role} 的模型 ${id} 不在 pooling 表里，回落到 mean。**这可能是错的且不会报错** ——\n` +
			`  查一下它仓库里的 1_Pooling/config.json，补一行到 Models.ts 的 POOLING_BY_MODEL，\n` +
			`  或显式 ${role === "句对" ? "PAIR_POOLING" : "RETR_POOLING"}=cls|mean。实测配错的代价是少一成多的命中率。\n`,
	);
	return "mean";
}

export interface LabEncoders extends PairEncoder, LabRetrievalEncoder {
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
		/**
		 * ④ 比的是问题还是答案。**和模型 id 一样要摊在页面上** —— 同一个模型换个形态
		 * 就是另一个尺度（bge 上 0.1228 vs 0.3494），只显示模型名看不出跑的是哪一个。
		 */
		readonly rerankTarget: RerankTarget;
		/** 两个 embedding 模型各自的 pooling。配错不报错，所以要显示出来 */
		readonly pairPooling: string;
		readonly retrievalPooling: string;
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
		models: { pair: "stub", retrieval: "stub", rerank: null, rerankTarget: CE_TARGET, pairPooling: "—", retrievalPooling: "—" },
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
		// 检索模型加载失败回退到句对模型时，pooling 必须跟着**实际在用的那个模型**走
		const pairPooling = poolingFor(PAIR_ID, process.env.PAIR_POOLING, "句对");
		const retrievalPooling = retrOk
			? poolingFor(RETR_ID, process.env.RETR_POOLING, "检索")
			: pairPooling;

		let ceTok: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
		let ceModel: Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>> | null = null;
		try {
			process.stdout.write(`加载 cross-encoder ${CE_ID}（${CE_TARGET === "answer" ? "问↔答" : "问↔问"}）…\n`);
			ceTok = await AutoTokenizer.from_pretrained(CE_ID);
			ceModel = await AutoModelForSequenceClassification.from_pretrained(CE_ID);
		} catch (err) {
			process.stdout.write(`cross-encoder 加载失败，④ 将被跳过：${String(err)}\n`);
		}

		/**
		 * pooling 由调用处按模型给出，**不再写死 mean** —— 见 POOLING_BY_MODEL 的注释，
		 * 拿 mean 跑一个 CLS 模型会少一成多的命中率而且不报错。
		 */
		async function run(
			extractor: typeof pairEx,
			texts: ReadonlyArray<string>,
			prefix: string,
			pooling: Pooling,
		): Promise<Array<Array<number>>> {
			const input = prefix ? texts.map(t => `${prefix}${t}`) : [...texts];
			const out = await extractor(input, { pooling, normalize: true });
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
			note: `句对 ${PAIR_ID}（${pairPooling}）| 检索 ${retrOk ? RETR_ID : `${PAIR_ID}（回退）`}（${retrievalPooling}）| 重排 ${ceModel ? `${CE_ID}（${CE_TARGET === "answer" ? "问↔答" : "问↔问"}）` : "无"}`,
			models: {
				pair: PAIR_ID,
				retrieval: retrOk ? RETR_ID : `${PAIR_ID}（⚠ 回退，任务错配）`,
				rerank: ceModel ? CE_ID : null,
				rerankTarget: CE_TARGET,
				pairPooling,
				retrievalPooling,
			},
			embedQuestions: texts => run(pairEx, texts, "", pairPooling),
			embedQuery: texts => run(retrEx, texts, usesE5Prefix ? "query: " : "", retrievalPooling),
			embedPassage: texts => run(retrEx, texts, usesE5Prefix ? "passage: " : "", retrievalPooling),
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
