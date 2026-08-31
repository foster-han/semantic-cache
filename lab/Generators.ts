/**
 * 生成端。**这是验证台唯一一处真正要花钱/花时间的地方,所以做成可切换的接口。**
 *
 * 默认 `stub` —— 把检索到的首个片段换序换壳。它有一个**已知且严重**的方法学缺陷:
 * 真答案是 LLM 改写、压缩、综合过的,向量分布跟原始片段差得远;而 stub 几乎是
 * 原文照抄,所以 ⑥ 的支撑度天然偏高(实测能到 0.98+)。**θa 的绝对值在 stub 上
 * 标不准**,这是文章里唯一还没被验证的那一环。
 *
 * `GEN=claude-cli` 用本机的 Claude Code 做真生成,专门用来回答那个问题:
 * 换成真 LLM 之后,支撑度分布会塌多少,现在这组 θa 还立不立得住。
 */
import { spawn } from "node:child_process";
import type { CachedPayload, CachePrompt, Chunk } from "../sdk/src/index.ts";
import { compose, refineSuffix } from "./Corpus.ts";
import type { ComposeChunk } from "./types/Corpus.ts";

/** 检索片段带着 title/version —— `Chunk` 里没有，取的时候防御一下。 */
function titleOf(chunk: Chunk): string {
	const title = (chunk as { title?: unknown }).title;
	return typeof title === "string" ? title : chunk.id;
}

/**
 * 提示走 **stdin**，不进 argv。资料块可能很长，而且里面什么字符都有 ——
 * 塞进命令行参数会撞上长度上限，也会把引号问题变成静默的内容损坏。
 */
function runClaude(args: ReadonlyArray<string>, prompt: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("claude", [...args], { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`超时 ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.on("data", d => (out += String(d)));
		child.stderr.on("data", d => (err += String(d)));
		child.on("error", e => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", code => {
			clearTimeout(timer);
			if (code === 0) resolve(out);
			else reject(new Error(`退出码 ${String(code)}：${err.trim().slice(0, 300)}`));
		});
		child.stdin.end(prompt);
	});
}

export type GeneratorKind = "stub" | "claude-cli";

export interface LabGenerator {
	readonly kind: GeneratorKind;
	readonly note: string;
	/** 一次生成大概多久 —— 页面上要据此提示"这张卡跑不完" */
	readonly approxMsPerCall: number;
	generate(prompt: CachePrompt, chunks: ReadonlyArray<Chunk>): Promise<CachedPayload>;
	refine(cachedAnswer: string, prompt: CachePrompt, chunks: ReadonlyArray<Chunk>): Promise<CachedPayload>;
}

/**
 * 片段拼成资料块。**顺序即重要性**,和 `sourceIds` 一致 ——
 * 判据是 `sourceIds[0]`,所以首个片段必须是排第一的那个。
 */
function materials(chunks: ReadonlyArray<Chunk>): string {
	return chunks
		.map((c, i) => `【资料 ${i + 1}】《${titleOf(c)}》\n${c.text}`)
		.join("\n\n");
}

const SYSTEM =
	"你是一门机器学习课程的助教。只根据给出的资料回答学生的问题,不要引入资料以外的知识,也不要编造。" +
	"用两三句话讲清楚,语气平实,不要罗列要点,不要重复问题,不要写开场白。直接给答案。";

/* ---------- stub ---------- */

function stubGenerator(): LabGenerator {
	return {
		kind: "stub",
		note: "拼接检索到的首个片段并换序换壳 —— 不是真生成,⑥ 的支撑度天然偏高",
		approxMsPerCall: 0,
		async generate(_prompt, chunks) {
			return { kind: "answer", answer: compose(chunks as unknown as ReadonlyArray<ComposeChunk>), sourceIds: chunks.map(c => c.id) };
		},
		async refine(cachedAnswer, _prompt, chunks) {
			return {
				kind: "answer",
				answer: `${cachedAnswer}${refineSuffix(chunks[0] ? titleOf(chunks[0]) : "—")}`,
				sourceIds: chunks.map(c => c.id),
			};
		},
	};
}

/* ---------- claude -p ---------- */

/**
 * 走本机 Claude Code 的 print 模式。
 *
 * 选它而不是 Messages API,是因为**不需要另配 API key** —— 复用你已经登录的
 * Claude Code。代价是每次要起一个进程,实测约 8.5 秒,所以完整 bench 跑不动
 * (13 场景 × 30 条干扰 ≈ 416 次 ≈ 1 小时)。重新标定和手动/场景验证够用。
 *
 * **失败必须抛错,不能悄悄退回 stub** —— 那样标出来的 θa 会是两种分布混出来的,
 * 比标不准更糟。
 */
function claudeCliGenerator(): LabGenerator {
	const model = process.env.GEN_MODEL;
	const timeoutMs = Number(process.env.GEN_TIMEOUT_MS ?? 120_000);

	async function ask(prompt: string): Promise<string> {
		const args = ["-p", "--append-system-prompt", SYSTEM];
		if (model) args.push("--model", model);
		try {
			const text = (await runClaude(args, prompt, timeoutMs)).trim();
			if (text === "") throw new Error("claude -p 返回空");
			return text;
		} catch (err) {
			throw new Error(
				`claude -p 生成失败(GEN=claude-cli)。这里不退回 stub —— 两种分布混在一起标出来的 θa 比标不准更糟。原始错误:${String(err)}`,
			);
		}
	}

	return {
		kind: "claude-cli",
		note: `claude -p${model ? `(${model})` : ""} —— 真生成,约 8.5 秒一次,完整 bench 跑不动`,
		approxMsPerCall: 8_500,
		async generate(prompt, chunks) {
			const answer =
				chunks.length === 0
					? "（本课程下没有可用资料）"
					: await ask(`${materials(chunks)}\n\n学生的问题:${prompt.retrievalText}`);
			// 没有资料时 sourceIds 为空 —— SDK 会因此不把它写进缓存,这是对的
			return { kind: "answer", answer, sourceIds: chunks.map(c => c.id) };
		},
		async refine(cachedAnswer, prompt, chunks) {
			const answer = await ask(
				`${materials(chunks)}\n\n学生的问题:${prompt.retrievalText}\n\n` +
					`下面是之前给别的同学的答案,大体对但不一定贴合这次的资料。请**基于上面的资料**把它改得贴合,` +
					`能沿用就沿用,不要从头重写:\n${cachedAnswer}`,
			);
			return { kind: "answer", answer, sourceIds: chunks.map(c => c.id) };
		},
	};
}

export function createGenerator(): LabGenerator {
	const wanted = process.env.GEN ?? "stub";
	if (wanted === "claude-cli") return claudeCliGenerator();
	if (wanted !== "stub") throw new Error(`GEN=${wanted} 无法识别。只能是 stub / claude-cli。`);
	return stubGenerator();
}
