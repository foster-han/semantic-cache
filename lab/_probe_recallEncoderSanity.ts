/**
 * ③ 换成**为语义缓存微调过的**编码器会怎样。
 *
 * QQP 上当时的 ③（paraphrase-multilingual-MiniLM）正命中率只有 72.4%，而 GPTCache
 * 公布的是 >97%。差距未必是「语义缓存做不到」，更可能是**通用模型零样本不够** ——
 * Redis 那篇 Closing the Calibration Gap 的卖点就是在 langcache-sentencepairs 上微调，
 * 而他们把模型公开了：`redis/langcache-embed-v1`（gte-modernbert-base 微调，有 ONNX）。
 *
 * **pooling 必须是 CLS。** 这个模型的 1_Pooling/config.json 写着
 * `pooling_mode_cls_token: true`、`pooling_mode_mean_tokens: false`，而 lab 现在的
 * `run()` 一律传 `pooling: "mean"`。配错不会报错，只会给出没有判别力的向量 ——
 * 所以这里把**故意配错 mean** 也跑一遍，把代价量出来，而不是嘴上说说。
 *
 * 这一步只做小样本自检：能不能加载、CLS 与 mean 差多少。全量对照在 _probe_langcache2.ts。
 */
import { pipeline } from "@huggingface/transformers";
import { cosine } from "./Models.ts";

const PROBES: ReadonlyArray<readonly [string, string, string, boolean]> = [
	["同义改写   应高", "How do I reset my password?", "I forgot my password, what should I do?", true],
	["同义改写   应高", "Is there a reason why we should travel alone?", "What are some reasons to travel alone?", true],
	["实体不同   应低", "Why are African-Americans so beautiful?", "Why are hispanics so beautiful?", false],
	["近义反义   应低", "What is overfitting?", "What is underfitting?", false],
	["完全无关   应低", "What is recursion?", "Who was the 44th US president?", false],
];

const CONFIGS = [
	["当时的 ③（多语种句对模型）—— 现默认已是 all-MiniLM-L6-v2", "Xenova/paraphrase-multilingual-MiniLM-L12-v2", "mean"],
	["langcache-embed-v1 · CLS（正确）", "redis/langcache-embed-v1", "cls"],
	["langcache-embed-v1 · mean（**故意配错**）", "redis/langcache-embed-v1", "mean"],
] as const;

for (const [label, id, pooling] of CONFIGS) {
	process.stdout.write(`\n=== ${label} ===\n  ${id} · pooling=${pooling}\n`);
	try {
		// 这个库只发了非量化的 onnx/model.onnx，所以必须显式 fp32；默认会去找 model_quantized
		const ex = await pipeline("feature-extraction", id, { dtype: "fp32" });
		const texts = PROBES.flatMap(p => [p[1], p[2]]);
		const out = await ex(texts, { pooling, normalize: true });
		const v = out.tolist() as Array<Array<number>>;
		const pos: Array<number> = [];
		const neg: Array<number> = [];
		for (let i = 0; i < PROBES.length; i++) {
			const s = cosine(v[i * 2], v[i * 2 + 1]);
			(PROBES[i][3] ? pos : neg).push(s);
			process.stdout.write(`  ${PROBES[i][0]}  ${s.toFixed(4)}  ${PROBES[i][1].slice(0, 44)}\n`);
		}
		const margin = Math.min(...pos) - Math.max(...neg);
		process.stdout.write(
			`  → 正例最低 ${Math.min(...pos).toFixed(4)}　负例最高 ${Math.max(...neg).toFixed(4)}　` +
				`margin ${margin >= 0 ? "+" : ""}${margin.toFixed(4)}　${margin > 0 ? "可分" : "**不可分**"}\n`,
		);
	} catch (err) {
		process.stdout.write(`  ✗ 加载/推理失败：${String(err).slice(0, 200)}\n`);
	}
}
