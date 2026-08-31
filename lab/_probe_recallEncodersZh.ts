/** langcache-embed-v1 在**中文**上还有判别力吗 —— 它的基座 gte-modernbert-base 是英文模型。 */
import { pipeline } from "@huggingface/transformers";
import { cosine } from "./Models.ts";
import { RERANK_PROBES } from "./CorpusZh.ts";

const EXTRA: ReadonlyArray<readonly [string, string, string, boolean]> = [
	["同义改写（该高）", "为什么要做 k 折交叉验证？", "交叉验证有什么用？", true],
	["同义改写（该高）", "学习率太大会怎么样？", "学习率设得过大有什么后果？", true],
	["实体不同（该低）", "Hinton 提出了什么方法？", "LeCun 提出了什么方法？", false],
];
const PROBES = [
	...RERANK_PROBES.map(p => [p.label, p.a, p.b, p.shouldMatch] as const),
	...EXTRA,
];

for (const [label, id, pooling] of [
	["现在的 ③（多语种，中文基线）", "Xenova/paraphrase-multilingual-MiniLM-L12-v2", "mean"],
	["langcache-embed-v1 · CLS", "redis/langcache-embed-v1", "cls"],
] as const) {
	process.stdout.write(`\n=== ${label} ===\n`);
	const ex = await pipeline("feature-extraction", id, { dtype: "fp32" });
	const out = await ex(PROBES.flatMap(p => [p[1], p[2]]), { pooling, normalize: true });
	const v = out.tolist() as Array<Array<number>>;
	const pos: Array<number> = [];
	const neg: Array<number> = [];
	for (let i = 0; i < PROBES.length; i++) {
		const s = cosine(v[i * 2], v[i * 2 + 1]);
		(PROBES[i][3] ? pos : neg).push(s);
		process.stdout.write(`  ${String(PROBES[i][0]).padEnd(22)} ${s.toFixed(4)}  ${PROBES[i][1].slice(0, 26)}\n`);
	}
	const margin = Math.min(...pos) - Math.max(...neg);
	process.stdout.write(
		`  → 正例最低 ${Math.min(...pos).toFixed(4)}　负例最高 ${Math.max(...neg).toFixed(4)}　` +
			`margin ${margin >= 0 ? "+" : ""}${margin.toFixed(4)}　${margin > 0 ? "可分" : "**不可分**"}\n`,
	);
}
