/**
 * 把所有 (数据集 × 打分器) 的分数算一遍存盘，**顺带计时**。
 *
 * 分开成两步的理由：模型推理是这里唯一贵的东西（五个打分器 × 四份数据 ≈ 二十分钟），
 * 而后面要做的分析 —— 套 GPTCache 的默认阈值、扫 ③④ 串联的二维阈值、换 precision
 * 约束 —— 全是纯计算。先前每换一个问题就重跑一遍模型，同一份分数算了三四次。
 *
 * 分数存进 `data/scores.json` 并入库：它是 FINDINGS 里那些表的直接来源，
 * 而模型推理在同一个模型上是确定的，所以分数文件本身就是可复现的凭据。
 *
 * 打分器里有一个**主流基线**：`gptcache-albert` 是 GPTCache 的默认编码器
 * （`paraphrase-albert-small-v2`，mean pooling），用来和自研的几档放在同一把尺子上。
 *
 * **`key` 是给表用的名字，`id` 才是被测的东西 —— 两者会脱钩。**
 * `semcache-pair` 这个 key 的注释一直写着「③ 现在的默认」，而默认在
 * `Models.ts` 里早已从 `paraphrase-multilingual-MiniLM-L12-v2` 换成
 * `all-MiniLM-L6-v2`，这里没跟着改：于是 FINDINGS 里标着「现在的默认」的四列，
 * 量的全是上一个模型。又一次「不报错的错配」，这次错在元数据上。
 * 所以下面的复用是**按 (id × pooling) 认的，不按 key 认** —— 改了 id 就必然重算，
 * 一个 key 不可能挂着另一个模型的分数。
 *
 *   node --experimental-strip-types scripts/scorePairs.ts   # 只算缺的
 *   RESCORE=1 node --experimental-strip-types scripts/scorePairs.ts   # 全部重算
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AutoModelForSequenceClassification, AutoTokenizer, pipeline } from "@huggingface/transformers";
import { cosine } from "../Models.ts";
import { scoreFromLogits } from "../ProbeMetrics.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const OUT = join(DATA_DIR, "scores.json");

interface Pair {
	readonly sentence1?: string;
	readonly sentence2?: string;
	readonly question1?: string;
	readonly question2?: string;
	readonly label: number;
}

/**
 * 打分器：`kind` 决定它是 ③ 那类（两句各自编码算余弦）还是 ④ 那类（一次前向）。
 *
 * `pooling` 每个都按仓库的 `1_Pooling/config.json` 填，**不按系列推广** ——
 * 同一条规矩在 `Models.ts` 的 `POOLING_BY_MODEL` 上已经栽过一次（gte 两代相反）。
 * 拿 mean 跑一个 CLS 模型不报错，只是少一成多的命中率。
 *
 * ③ 那一档现在有五个候选，都是 384 维（换了不动存储 —— 表名与 key 前缀带维度）：
 * 现默认、上一个默认、同族大一档，外加两个 MTEB 小模型档。**谁最好按数据说话，
 * 而 out-of-domain 那两行此前的答案是「三个编码器互有胜负」。**
 */
const SCORERS = [
	{ key: "gptcache-albert", kind: "bi", id: "Xenova/paraphrase-albert-small-v2", pooling: "mean", note: "GPTCache 默认编码器（主流基线）" },
	{ key: "semcache-pair", kind: "bi", id: "Xenova/all-MiniLM-L6-v2", pooling: "mean", note: "semcache ③ 现在的默认（22M，英文对称句对）" },
	{ key: "pair-multilingual", kind: "bi", id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", pooling: "mean", note: "semcache ③ 的上一个默认（多语种，118M）" },
	{ key: "all-minilm-l12", kind: "bi", id: "Xenova/all-MiniLM-L12-v2", pooling: "mean", note: "同族大一档（33M）—— 量这条曲线的斜率" },
	{ key: "bge-small-en", kind: "bi", id: "Xenova/bge-small-en-v1.5", pooling: "cls", note: "MTEB 小模型档（33M，CLS pooling）" },
	{ key: "gte-small", kind: "bi", id: "Xenova/gte-small", pooling: "mean", note: "MTEB 小模型档（33M，thenlper 那一代用 mean）" },
	{ key: "langcache-embed", kind: "bi", id: "redis/langcache-embed-v1", pooling: "cls", note: "Redis 为语义缓存微调（CLS pooling）" },
	{ key: "ce-msmarco", kind: "cross", id: "Xenova/ms-marco-MiniLM-L-6-v2", pooling: undefined, note: "semcache ④ 现在的默认重排器" },
	{ key: "ce-bge", kind: "cross", id: "Xenova/bge-reranker-base", pooling: undefined, note: "semcache ④ 的可用替代" },
] as const;

const files = (await readdir(DATA_DIR)).filter(f => f.startsWith("langcache-") && f.endsWith(".json")).sort();
const datasets = await Promise.all(
	files.map(async f => {
		const raw = JSON.parse(await readFile(join(DATA_DIR, f), "utf8")) as {
			source: string;
			positiveRate?: number;
			pairs: Array<Pair>;
		};
		return {
			name: f.replace(/^langcache-|\.json$/gu, ""),
			source: raw.source,
			a: raw.pairs.map(p => p.sentence1 ?? p.question1 ?? ""),
			b: raw.pairs.map(p => p.sentence2 ?? p.question2 ?? ""),
			labels: raw.pairs.map(p => p.label),
		};
	}),
);

interface Entry {
	readonly scores: ReadonlyArray<number>;
	/** 每对的平均耗时（毫秒）—— 性能对比要的就是这个 */
	readonly msPerPair: number;
}
const out: Record<string, Record<string, Entry>> = {};

interface Snapshot {
	readonly scorers: ReadonlyArray<{ key: string; id: string; kind: string; pooling?: string; note: string }>;
	readonly datasets: ReadonlyArray<{ name: string; source: string; labels: Array<number> }>;
	readonly scores: Record<string, Record<string, Entry>>;
}

/**
 * 上一轮的分数，用来跳过没变的模型。**认的是 (id × pooling)，不是 key。**
 *
 * 加一个 ③ 的候选先前意味着把五个打分器全重算一遍（其中 `ce-bge` 87.6 ms/对、
 * `langcache-embed` 108.3 ms/对，两个就占掉大半时间），于是「顺手多量一个模型」
 * 变成了二十分钟的决定 —— 而这正是那张表长期停在旧模型上的原因之一。
 */
let prev: Snapshot | null = null;
try {
	prev = JSON.parse(await readFile(OUT, "utf8")) as Snapshot;
} catch {
	prev = null;
}
const RESCORE = process.env.RESCORE === "1";
const prevByModel = new Map<string, string>();
for (const s of prev?.scorers ?? []) prevByModel.set(`${s.id}|${s.pooling ?? ""}`, s.key);
/** 标签变了就是另一份数据 —— 数据换过还复用旧分数，是把两轮取样混成一张表 */
const prevLabels = new Map<string, string>();
for (const d of prev?.datasets ?? []) prevLabels.set(d.name, JSON.stringify(d.labels));

function reusableFrom(id: string, pooling: string | undefined): Record<string, Entry> | null {
	if (RESCORE || !prev) return null;
	const key = prevByModel.get(`${id}|${pooling ?? ""}`);
	if (key === undefined) return null;
	const entry = prev.scores[key];
	if (!entry) return null;
	for (const d of datasets) {
		if (!entry[d.name]) return null;
		if (prevLabels.get(d.name) !== JSON.stringify(d.labels)) return null;
	}
	return entry;
}

for (const s of SCORERS) {
	process.stdout.write(`\n=== ${s.key} · ${s.id} ===\n`);
	const reuse = reusableFrom(s.id, s.pooling);
	if (reuse) {
		out[s.key] = reuse;
		process.stdout.write(`  复用上一轮的分数（同 id 同 pooling 同标签）。要重算：RESCORE=1\n`);
		continue;
	}
	const t0 = Date.now();
	const bi = s.kind === "bi" ? await pipeline("feature-extraction", s.id, { dtype: "fp32" }) : null;
	const tok = s.kind === "cross" ? await AutoTokenizer.from_pretrained(s.id) : null;
	const ce = s.kind === "cross" ? await AutoModelForSequenceClassification.from_pretrained(s.id) : null;
	const entail = ce
		? Object.values((ce.config as { id2label?: Record<string, string> }).id2label ?? {}).findIndex(l => /entail/i.test(l))
		: -1;
	process.stdout.write(`  加载 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

	out[s.key] = {};
	for (const d of datasets) {
		const started = Date.now();
		const scores: Array<number> = [];
		if (bi) {
			for (let i = 0; i < d.labels.length; i += 64) {
				const sa = d.a.slice(i, i + 64);
				const sb = d.b.slice(i, i + 64);
				const res = await bi(sa.flatMap((x, k) => [x, sb[k]]), { pooling: s.pooling, normalize: true });
				const v = res.tolist() as Array<Array<number>>;
				for (let k = 0; k < sa.length; k++) scores.push(cosine(v[k * 2], v[k * 2 + 1]));
			}
		} else if (tok && ce) {
			for (let i = 0; i < d.labels.length; i++) {
				const inp = await tok(d.a[i], { text_pair: d.b[i], padding: true, truncation: true });
				const { logits } = await ce(inp);
				scores.push(
					scoreFromLogits(Array.from(logits.data as ArrayLike<number>, Number), logits.dims as ReadonlyArray<number>, entail),
				);
			}
		}
		const ms = (Date.now() - started) / d.labels.length;
		out[s.key][d.name] = { scores, msPerPair: ms };
		process.stdout.write(`  ${d.name.padEnd(9)} ${d.labels.length} 对　${ms.toFixed(1)} ms/对\n`);
	}
}

await writeFile(
	OUT,
	JSON.stringify(
		{
			note:
				"每个 (打分器 × 数据集) 的原始分数与耗时。FINDINGS 里那些表都是从这份算出来的 —— " +
				"分析是纯计算，不必重跑模型。同一个模型上推理是确定的，所以这份文件就是可复现的凭据。",
			scorers: SCORERS.map(s => ({ key: s.key, id: s.id, kind: s.kind, pooling: s.pooling, note: s.note })),
			datasets: datasets.map(d => ({ name: d.name, source: d.source, labels: d.labels })),
			scores: out,
		},
		null,
		"\t",
	),
	"utf8",
);
process.stdout.write(`\n写入 ${OUT}\n`);
