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
 *   node --experimental-strip-types scripts/scorePairs.ts
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

/** 打分器：`kind` 决定它是 ③ 那类（两句各自编码算余弦）还是 ④ 那类（一次前向） */
const SCORERS = [
	{ key: "gptcache-albert", kind: "bi", id: "Xenova/paraphrase-albert-small-v2", pooling: "mean", note: "GPTCache 默认编码器（主流基线）" },
	{ key: "semcache-pair", kind: "bi", id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", pooling: "mean", note: "semcache ③ 现在的默认" },
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

for (const s of SCORERS) {
	process.stdout.write(`\n=== ${s.key} · ${s.id} ===\n`);
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
