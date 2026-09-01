/**
 * 生成端。**这是验证台唯一一处真正要花钱/花时间的地方,所以做成可切换的接口。**
 *
 * 默认 `stub` —— 把检索到的首个片段换序换壳。它有一个**已知且严重**的方法学缺陷:
 * 真答案是 LLM 改写、压缩、综合过的,向量分布跟原始片段差得远;而 stub 几乎是
 * 原文照抄,所以 ⑥ 的支撑度天然偏高(实测能到 0.98+)。**θa 的绝对值在 stub 上
 * 标不准**,这是文章里唯一还没被验证的那一环。
 *
 * 三个真生成选项都在回答同一个问题:换成真 LLM 之后,支撑度分布会塌多少,
 * 现在这组 θa 还立不立得住。
 *
 *   GEN=claude-cli   起一个 `claude -p` 进程,复用 Claude Code 登录,约 8.5 秒/次
 *   GEN=api          直接打 Messages API,同一套凭据,约 1~2 秒/次
 *   GEN=deepseek     直接打 DeepSeek HTTP,约 1~3 秒/次
 */
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import type { CachedPayload, CachePrompt, Chunk } from "../sdk/src/index.ts";
import { compose, LANGUAGE, refineSuffix } from "./Corpus.ts";
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

export type GeneratorKind = "stub" | "claude-cli" | "api" | "deepseek";

export interface LabGenerator {
	readonly kind: GeneratorKind;
	readonly note: string;
	/** 一次生成大概多久 —— 页面上要据此提示"这张卡跑不完" */
	readonly approxMsPerCall: number;
	/**
	 * `variant` 用来取**同一输入的不同采样**。
	 *
	 * 不加它的话「多采样」是假的：DeepSeek 在 temperature 0.2 下同 prompt 同输出，
	 * 实测同一轮内 3 次采样一字不差（区间 `x~x`），压不掉任何噪声。
	 * 走 `seed` 而不是抬 temperature —— 抬温度会改变被测的那个分布本身。
	 */
	generate(prompt: CachePrompt, chunks: ReadonlyArray<Chunk>, variant?: number): Promise<CachedPayload>;
	refine(cachedAnswer: string, prompt: CachePrompt, chunks: ReadonlyArray<Chunk>): Promise<CachedPayload>;
}

/**
 * 提示词的**框架**,跟着语料语言走。
 *
 * 系统提示词是模型挑答案语言的最强信号 —— 中文框架配英文语料(`npm start` 的默认形态,
 * `CORPUS_LANG` 不设就是 en),问的是英文、答的是中文。除了看着别扭,它还坏了两件事:
 * ⑥ 的支撑度是拿答案去比 passage 空间里的英文资料,跨语言比出来的分数是另一个尺度;
 * 而缓存里存的答案语言和后续提问对不上。
 *
 * 整组必须同语言 —— system、资料抬头、提问抬头、refine 指令、无资料兜底。
 * 混着来等于在 prompt 里塞进另一种语言的噪声,而这台东西量的就是分数。
 */
interface PromptFrame {
	readonly system: string;
	/** 资料块的抬头,`n` 从 1 起 */
	material(n: number, title: string): string;
	question(text: string): string;
	refine(cachedAnswer: string): string;
	/** 一篇资料都没检索到时的答案 —— 和语料 `compose()` 的兜底同一句话 */
	readonly noMaterials: string;
}

const FRAMES: Readonly<Record<"en" | "zh", PromptFrame>> = {
	en: {
		system:
			"You are the teaching assistant for a machine learning course. Answer the student's question using only " +
			"the material given below; do not bring in knowledge from outside it, and do not make anything up. " +
			"Two or three sentences, plain tone, no bullet lists, no restating the question, no preamble. " +
			"Just give the answer, in English.",
		material: (n, title) => `[Material ${n}] "${title}"`,
		question: text => `Student's question: ${text}`,
		refine: cachedAnswer =>
			"Below is an answer given earlier to a different student. It is broadly right but may not fit this " +
			"material. Rewrite it **based on the material above** so that it does fit; keep whatever you can, " +
			`don't start over:\n${cachedAnswer}`,
		noMaterials: "(No material available for this course.)",
	},
	zh: {
		system:
			"你是一门机器学习课程的助教。只根据给出的资料回答学生的问题,不要引入资料以外的知识,也不要编造。" +
			"用两三句话讲清楚,语气平实,不要罗列要点,不要重复问题,不要写开场白。直接给答案。",
		material: (n, title) => `【资料 ${n}】《${title}》`,
		question: text => `学生的问题：${text}`,
		refine: cachedAnswer =>
			"下面是之前给别的同学的答案，大体对但不一定贴合这次的资料。请**基于上面的资料**把它改得贴合，" +
			`能沿用就沿用，不要从头重写：\n${cachedAnswer}`,
		noMaterials: "（本课程下没有可用资料）",
	},
};

const FRAME = FRAMES[LANGUAGE];
const SYSTEM = FRAME.system;

/**
 * 片段拼成资料块。**顺序即重要性**,和 `sourceIds` 一致 ——
 * 判据是 `sourceIds[0]`,所以首个片段必须是排第一的那个。
 */
function materials(chunks: ReadonlyArray<Chunk>): string {
	return chunks.map((c, i) => `${FRAME.material(i + 1, titleOf(c))}\n${c.text}`).join("\n\n");
}

/**
 * 三个真生成端送出去的用户消息**必须逐字一样** —— 它们是同一个被测对象的三次实现,
 * 差一个字就不是在同一份 prompt 上比支撑度了。所以拼装只此一处。
 */
function userPrompt(prompt: CachePrompt, chunks: ReadonlyArray<Chunk>): string {
	return `${materials(chunks)}\n\n${FRAME.question(prompt.retrievalText)}`;
}

function refinePrompt(cachedAnswer: string, prompt: CachePrompt, chunks: ReadonlyArray<Chunk>): string {
	return `${userPrompt(prompt, chunks)}\n\n${FRAME.refine(cachedAnswer)}`;
}

/* ---------- stub ---------- */

function stubGenerator(): LabGenerator {
	return {
		kind: "stub",
		note: "拼接检索到的首个片段并换序换壳 —— 不是真生成,⑥ 的支撑度天然偏高",
		approxMsPerCall: 0,
		// stub 是确定性的，variant 无意义 —— 如实忽略，别装作采样了
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
			const answer = chunks.length === 0 ? FRAME.noMaterials : await ask(userPrompt(prompt, chunks));
			// 没有资料时 sourceIds 为空 —— SDK 会因此不把它写进缓存,这是对的
			return { kind: "answer", answer, sourceIds: chunks.map(c => c.id) };
		},
		async refine(cachedAnswer, prompt, chunks) {
			const answer = await ask(refinePrompt(cachedAnswer, prompt, chunks));
			return { kind: "answer", answer, sourceIds: chunks.map(c => c.id) };
		},
	};
}

/* ---------- DeepSeek（OpenAI 兼容的 /chat/completions） ---------- */

/* ---------- Messages API ---------- */

/**
 * 直接打 Messages API。**和 `GEN=claude-cli` 是同一套凭据，只是不再每次起进程。**
 *
 * 零参构造的 `new Anthropic()` 会依次解析 `ANTHROPIC_API_KEY` →
 * `ANTHROPIC_AUTH_TOKEN` → `ant auth login` 存在 `~/.config/anthropic/` 的 OAuth
 * profile。**所以这条路不需要 API key** —— 跑过一次 `ant auth login` 就够了，
 * 这正是它比 `GEN=deepseek` 少一件事要配的地方。
 *
 * 三处和隔壁 DeepSeek 那条不一样、且不是风格差异的地方：
 *
 * 1. **不传 `temperature`。** Opus 5 / Sonnet 5 这一代已经把采样参数移除了，传了直接 400。
 *    想让生成稳定就靠低 effort，不靠调温度。
 * 2. **不自己写重试循环。** SDK 自带重试（429/5xx/连接错误，默认 2 次），
 *    手写一层只会和它叠在一起，把退避算成两遍。
 * 3. **thinking 保持默认开着，只把 effort 压到 low。** Opus 5 上显式关思考有两个坑：
 *    工具调用会漏进可见文本、`<thinking>` 标签会泄漏。降 effort 一样省，而且没这些副作用。
 */
function apiGenerator(): LabGenerator {
	const model = process.env.GEN_MODEL ?? "claude-opus-5";
	const timeoutMs = Number(process.env.GEN_TIMEOUT_MS ?? 120_000);
	const client = new Anthropic({ timeout: timeoutMs });

	/**
	 * `variant` 在这里**故意不进请求体** —— Anthropic 的 Messages API 没有 `seed`。
	 * 不带 `temperature` 就是默认的 1.0，同一份输入重复调本来就会给出不同采样，
	 * 所以「取第 k 个样本」只需要记忆化不把它们合并掉（`memoize` 把 variant 进了 key）。
	 * 别在这里补一个 `temperature`：抬温度会改变被测的分布，理由同 deepseek 那边。
	 */
	async function ask(user: string, variant?: number): Promise<string> {
		void variant;
		let response: Anthropic.Message;
		try {
			response = await client.messages.create({
				model,
				// 答案就两三句，但 thinking 的 token 也算在这个上限里，留够余量
				max_tokens: 4096,
				output_config: { effort: "low" },
				system: SYSTEM,
				messages: [{ role: "user", content: user }],
			});
		} catch (err) {
			// 「找不到凭据」是构造期就抛的普通 Error，不是 AuthenticationError（那是服务端 401），
			// 两种都要认 —— 前者才是最常见的那一种：装了 Claude Code 不等于 SDK 能读到凭据
			const message = String(err);
			const noCredentials =
				err instanceof Anthropic.AuthenticationError || /Could not resolve authentication method/iu.test(message);
			const hint = noCredentials
				? "SDK 找不到凭据。**Claude Code 自己的登录不算** —— SDK 读的是 `ant auth login` " +
					"写在 ~/.config/anthropic/ 的 profile。跑一次 `ant auth login`（不需要 API key），" +
					"或者 export ANTHROPIC_API_KEY。"
				: err instanceof Anthropic.RateLimitError
					? "被限流了，等一会儿再跑。"
					: "";
			throw new Error(
				`Messages API 生成失败（GEN=api, model=${model}）。这里不退回 stub —— ` +
					`两种分布混在一起标出来的 θa 比标不准更糟。${hint}原始错误：${message}`,
			);
		}

		// 安全分类器可能拒答：HTTP 200，但 content 里没有答案。先看 stop_reason 再读 content
		if (response.stop_reason === "refusal") {
			throw new Error(
				`Messages API 拒答（category=${response.stop_details?.category ?? "未知"}）。` +
					`语料里出现了会触发分类器的内容，换一条用例，或者查一下 materials() 拼出来的东西。`,
			);
		}

		const text = response.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map(b => b.text)
			.join("")
			.trim();
		if (text === "") throw new Error(`Messages API 返回空内容（stop_reason=${String(response.stop_reason)}）`);
		return text;
	}

	return {
		kind: "api",
		note: `messages api ${model} —— 真生成，不需要 API key（走 ant auth 的 profile 也行）`,
		approxMsPerCall: 2_000,
		async generate(prompt, chunks, variant) {
			const answer = chunks.length === 0 ? FRAME.noMaterials : await ask(userPrompt(prompt, chunks), variant);
			return { kind: "answer", answer, sourceIds: chunks.map(c => c.id) };
		},
		async refine(cachedAnswer, prompt, chunks) {
			const answer = await ask(refinePrompt(cachedAnswer, prompt, chunks));
			return { kind: "answer", answer, sourceIds: chunks.map(c => c.id) };
		},
	};
}

/* ---------- DeepSeek ---------- */

/**
 * 直接打 HTTP，不经过任何 agent harness。
 *
 * 这是**第一个能在真生成下跑完整场景集的选项**：一次 1~3 秒，416 次约 15 分钟，
 * 而 `claude -p` 起进程要 8.5 秒、同样的量要一个多小时。有了它，「关掉 ⑥ 假命中
 * 从 0 升到 4」这类端到端结论才第一次能在真 LLM 上复验，而不是在 stub 上。
 *
 * 零依赖：Node 自带 fetch，不引任何 SDK。
 */
function deepseekGenerator(): LabGenerator {
	const key = process.env.DEEPSEEK_API_KEY;
	if (!key) {
		throw new Error(
			"GEN=deepseek 需要 DEEPSEEK_API_KEY。若你的 Codex 已经配好 DeepSeek，可以从那儿取：\n" +
				`  export DEEPSEEK_API_KEY=$(grep -oP 'experimental_bearer_token\\s*=\\s*"\\K[^"]+' ~/.codex/config.toml)`,
		);
	}
	const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/u, "");
	const model = process.env.GEN_MODEL ?? "deepseek-v4-flash";
	const timeoutMs = Number(process.env.GEN_TIMEOUT_MS ?? 120_000);

	async function ask(user: string, variant?: number): Promise<string> {
		// 429 和 5xx 是暂时的，值得重试；4xx 是请求本身错了，重试没意义
		let lastError = "";
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt > 0) await new Promise(r => setTimeout(r, 400 * 2 ** attempt));
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const res = await fetch(`${baseUrl}/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
					body: JSON.stringify({
						model,
						messages: [
							{ role: "system", content: SYSTEM },
							{ role: "user", content: user },
						],
						// 生成要稳定：同一份资料 + 同一个问题，两次跑出来的答案分布不该差太多，
						// 否则标定的支撑度是在测采样噪声
						temperature: 0.2,
						// 同输入取不同采样靠 seed，不靠抬温度 —— 后者会改变被测的分布
						...(variant === undefined ? {} : { seed: variant }),
						max_tokens: 400,
					}),
					signal: controller.signal,
				});
				const body = (await res.json()) as {
					choices?: Array<{ message?: { content?: string } }>;
					error?: { message?: string };
				};
				if (!res.ok) {
					lastError = `HTTP ${res.status}：${body.error?.message ?? "(无错误信息)"}`;
					if (res.status !== 429 && res.status < 500) break;
					continue;
				}
				const text = (body.choices?.[0]?.message?.content ?? "").trim();
				if (text === "") {
					lastError = "返回空内容";
					continue;
				}
				return text;
			} catch (err) {
				lastError = String(err);
			} finally {
				clearTimeout(timer);
			}
		}
		throw new Error(
			`DeepSeek 生成失败（GEN=deepseek, model=${model}）。这里不退回 stub —— ` +
				`两种分布混在一起标出来的 θa 比标不准更糟。最后一次错误：${lastError}`,
		);
	}

	return {
		kind: "deepseek",
		note: `deepseek ${model} —— 真生成，约 1~3 秒一次，完整 bench 跑得动（~15 分钟）`,
		approxMsPerCall: 2_000,
		async generate(prompt, chunks, variant) {
			const answer = chunks.length === 0 ? FRAME.noMaterials : await ask(userPrompt(prompt, chunks), variant);
			return { kind: "answer", answer, sourceIds: chunks.map(c => c.id) };
		},
		async refine(cachedAnswer, prompt, chunks) {
			const answer = await ask(refinePrompt(cachedAnswer, prompt, chunks));
			return { kind: "answer", answer, sourceIds: chunks.map(c => c.id) };
		},
	};
}

/* ---------- 去重 ---------- */

/** 表满了就丢最早的。记忆化是为了省调用，不该反过来把内存吃了。 */
const MEMO_LIMIT = 2_000;

/**
 * 同一个（问题 + 资料 + 采样序号）只生成一次。**全仓库唯一的一层记忆化。**
 *
 * 那 30 条干扰会在 13 条场景里各灌一遍 —— 390 次调用里只有 30 个不同的组合。
 * 套上这一层，完整 bench 的真生成从 **416 次降到约 56 次**；26 条场景那一档实测
 * 832 次调用里只有 73 个不同输入，最热的一条重复 27 次，91% 的调用是在重复付
 * 同一笔钱。
 *
 * **先前有两份几乎一样的实现**（这个私有的，和一个导出的 `memoizeGenerator`），
 * `LabCache.benchGenerator()` 把生成端又套了一层：默认配置下 bench 是双层记忆化，
 * 而外层无条件存 promise、没有失败剔除也没有上限 —— 正好把下面 `once()` 那句
 * 「一次网络抖动会把这个 key 永久钉死在错误上」的防护撤销掉。两份合成这一份。
 *
 * **key 必须含片段原文，不能只含 id。** `bumpCorpus()` 改的是 syl 的正文而 id 不变；
 * 只按 id 记忆化的话，改版之后那次生成会拿到改版前的答案 —— ⑤ 那两条用例会静默变绿，
 * 而且是"测试通过了但机制没生效"这种最难发现的绿。
 *
 * key 覆盖的是**生成端真正送出去的东西**：现在三个真生成端送的都是
 * `materials(chunks)` + `retrievalText`。哪天有生成端改送 `matchText`，这里必须跟着加，
 * 否则两个不同的请求会共用一条缓存。
 *
 * 顺带一个副作用，而且是好的：真 LLM 有采样噪声，记忆化让同一组合在 A/B 两侧拿到
 * **逐字相同**的答案，于是对照实验测出来的差值只剩闸门的贡献，不含生成噪声。
 * 想反过来量一量那点噪声有多大，`GEN_MEMO=0` 关掉它。
 */
function memoize(inner: LabGenerator): LabGenerator {
	const memo = new Map<string, Promise<CachedPayload>>();

	/** id 和原文都进 key —— 只有 id 会漏掉语料改版 */
	function fingerprint(chunks: ReadonlyArray<Chunk>): Array<string> {
		return chunks.flatMap(c => [c.id, c.text]);
	}

	function once(key: string, run: () => Promise<CachedPayload>): Promise<CachedPayload> {
		const hit = memo.get(key);
		if (hit) return hit;
		// 存 promise 而不是结果，顺带把并发的重复请求也合并掉。
		// 但**失败的不能留在表里** —— 一次网络抖动会把这个 key 永久钉死在错误上。
		const pending = run().catch((err: unknown) => {
			memo.delete(key);
			throw err;
		});
		if (memo.size >= MEMO_LIMIT) {
			const oldest = memo.keys().next();
			if (!oldest.done) memo.delete(oldest.value);
		}
		memo.set(key, pending);
		return pending;
	}

	return {
		kind: inner.kind,
		note: `${inner.note}｜同一组合只生成一次`,
		approxMsPerCall: inner.approxMsPerCall,
		/**
		 * **`variant` 必须进 key，也必须转发下去。**
		 *
		 * 先前两样都漏了，于是「同一输入的第 k 次采样」全部撞进同一个 key：
		 * `calibrate.ts` 的 `CALIB_SAMPLES`（真生成端默认 3）在默认 `GEN_MEMO` 下
		 * 塌成一次调用，而且塌成的是 `variant === undefined` 那一次 —— 连 seed 都不带。
		 * 标出来的 θa 因此是单次采样的产物，而那个脚本的注释说得很清楚：
		 * 「单轮结果测的是采样噪声，不是分布」。
		 *
		 * 更难查的是它会**归错因**：`calibrate.ts` 的采样自检会发现 3 次逐位相同，
		 * 然后印出「同 prompt 同输出（如 DeepSeek 的 temperature 0.2）」—— 把记忆化的
		 * 锅算到生成端头上，而那个结论看起来完全合理。
		 */
		generate(prompt, chunks, variant) {
			return once(JSON.stringify(["generate", variant ?? null, prompt.retrievalText, ...fingerprint(chunks)]), () =>
				inner.generate(prompt, chunks, variant),
			);
		},
		refine(cachedAnswer, prompt, chunks) {
			return once(JSON.stringify(["refine", cachedAnswer, prompt.retrievalText, ...fingerprint(chunks)]), () =>
				inner.refine(cachedAnswer, prompt, chunks),
			);
		},
	};
}

/**
 * 生成端的唯一入口。**记忆化的决定只在这里做一次** —— 调用方拿到的就是最终形态，
 * 不要在外面再包一层（`LabCache` 先前包了，见 `memoize` 的注释）。
 *
 * 记忆化跨 bench 共享，这是有意的：key 里带片段原文，语料改版自动失效，所以
 * 「换个配置重跑」要的正是逐字相同的生成 —— A/B 的差值里不该混采样噪声。
 */
export function createGenerator(): LabGenerator {
	const wanted = process.env.GEN ?? "stub";
	// stub 不套记忆化 —— 它本来就是确定性的，而且免费，包一层只是多一份内存
	const wrap = (g: LabGenerator): LabGenerator => (process.env.GEN_MEMO === "0" ? g : memoize(g));
	if (wanted === "claude-cli") return wrap(claudeCliGenerator());
	if (wanted === "api") return wrap(apiGenerator());
	if (wanted === "deepseek") return wrap(deepseekGenerator());
	if (wanted !== "stub") throw new Error(`GEN=${wanted} 无法识别。只能是 stub / claude-cli / api / deepseek。`);
	return stubGenerator();
}

