import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { checkReranker, type ProbePair } from "../sdk/src/index.ts";
import { createEncoders } from "./Models.ts";
import { createLab } from "./LabCache.ts";
import { createLabStore } from "./Store.ts";
import { compose, COURSE, DOCS, LANGUAGE, RERANK_PROBES, SCENARIOS } from "./Corpus.ts";
import type { LabConfig } from "./types/LabConfig.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7788);
/** 与 SDK `checkReranker` 的默认值一致：margin 小于这个数就是任务错配 */
const MIN_RERANK_MARGIN = 0.15;

const encoders = await createEncoders();

// 向量列的维度必须跟编码器一致，所以从编码器上量，不写死：
// stub 是 256 维、e5-small 是 384 维，写死哪个都会在换 MODE 时炸在建表之后。
const [probeMatch] = await encoders.embedQuestions(["dimension probe"]);
const [probeAnswer] = await encoders.embedPassage(["dimension probe"]);
const backing = await createLabStore({ dimensions: { match: probeMatch.length, answer: probeAnswer.length } });
const lab = createLab(encoders, backing.store);

console.log(`\n模型后端：${encoders.mode}　—　${encoders.note}`);
console.log(`存储后端：${backing.kind}　—　${backing.note}`);
console.log(`生成后端：${lab.generator.kind}　—　${lab.generator.note}`);
console.log(lab.calibration.summary);
if (encoders.mode === "stub") {
	console.log("⚠  stub 模式的分数没有统计意义，只用来跑通控制流。真验证请用 MODE=local。");
}

function json(res: ServerResponse, code: number, body: unknown): void {
	res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Array<Buffer> = [];
	for await (const c of req) chunks.push(c as Buffer);
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function configOf(body: Record<string, unknown>): Partial<LabConfig> {
	return (body.config ?? {}) as Partial<LabConfig>;
}

/**
 * ④ 的自检探针，**按当前形态构造**。
 *
 * 探针跟着语料语言走这件事语料包里已经写了；这里是同一条规矩的另一半：它还得跟着
 * `CE_TARGET` 走。`target: "answer"` 时 ④ 比的是问↔答，而 `RERANK_PROBES` 的 `b`
 * 是问句 —— 拿它算出来的 margin 是另一个尺度上的数，看着正常、算得出来，
 * 和 ④ 实际用的分数没有关系。自检要是测错了尺度，它挡不住任何东西。
 *
 * 答案用语料的 `compose()` 拼，和运行路径、和 `_probe_ce6.ts` 同一个函数。
 */
function activeProbes(): ReadonlyArray<ProbePair> {
	if (encoders.models.rerankTarget !== "answer") return RERANK_PROBES;
	return RERANK_PROBES.map(p => {
		const doc = DOCS.find(d => d.id === p.bDoc);
		if (!doc) {
			throw new Error(
				`探针「${p.label}」的 bDoc=${p.bDoc} 在语料里找不到。target: "answer" 的自检需要 b 侧对应的文档 —— ` +
					"退回用问句当 candidate 会把自检测到另一个尺度上去，所以这里直接抛。",
			);
		}
		return { ...p, b: compose([{ title: doc.title, text: doc.text, version: doc.version }]) };
	});
}

async function snapshot() {
	return {
		// 四个互不相干的轴，页面顶部要把它们摊开显示 —— 「现在跑的到底是什么」
		// 不该靠翻启动日志或猜环境变量
		mode: encoders.mode,
		note: encoders.note,
		models: encoders.models,
		corpus: LANGUAGE,
		store: { kind: backing.kind, note: backing.note },
		metrics: lab.metrics(),
		generator: lab.generator,
		rerankAvailable: encoders.rerankAvailable,
		defaults: lab.defaults,
		// 阈值是哪一行标定出来的、有没有被借用/覆盖 —— 页面要照着这个说话
		calibration: {
			summary: lab.calibration.summary,
			borrowed: lab.calibration.borrowed,
			overridden: lab.calibration.overridden,
			recallNote: lab.calibration.recallNote,
			rerankNote: lab.calibration.rerankNote,
			supportNote: lab.calibration.supportNote,
		},
		course: COURSE,
		units: [...new Set(DOCS.map(d => d.unit))],
		scenarios: SCENARIOS.map(s => ({
			key: s.key,
			label: s.label,
			note: s.note,
			caveat: s.caveat ?? null,
			seed: s.seed,
			probe: s.probe,
			expect: s.expect,
			bumpCorpus: Boolean(s.bumpCorpus),
		})),
		// 正文也发。判据是「答案的首要依据是不是那篇资料」——
		// 页面上只看到 n7 / n9 两个 id 却读不到它们写了什么，这个判据就没法用眼睛复核
		docs: lab.docs.map(d => ({ id: d.id, unit: d.unit, title: d.title, version: d.version, text: d.text })),
		cache: (await lab.cache()).map(e => ({
			id: e.id,
			scope: e.scope,
			kind: e.kind,
			prompt: e.matchText,
			sources: e.sourceIds,
			corpusVersion: e.sourceVersion,
		})),
		counters: lab.counters,
	};
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	try {
		if (req.method === "GET" && url.pathname === "/") {
			const html = await readFile(join(here, "public", "index.html"), "utf8");
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(html);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/state") {
			json(res, 200, await snapshot());
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/ask") {
			const body = await readBody(req);
			const result = await lab.ask(
				{
					text: String(body.text ?? ""),
					user: String(body.user ?? "s1"),
					unit: body.unit ? String(body.unit) : undefined,
				},
				configOf(body),
			);
			json(res, 200, { ...result, state: await snapshot() });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/bench") {
			const body = await readBody(req);
			json(res, 200, { ...(await lab.bench(configOf(body))), state: await snapshot() });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/scenario") {
			// 场景回放跑在自己的缓存上 —— 不再需要浏览器先发一次 /api/reset
			const body = await readBody(req);
			const result = await lab.scenario(String(body.key ?? ""), configOf(body));
			if (!result) {
				json(res, 404, { error: `没有这个场景：${String(body.key ?? "")}` });
				return;
			}
			json(res, 200, { ...result, state: await snapshot() });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/metrics") {
			json(res, 200, lab.metrics());
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/metrics/reset") {
			lab.resetMetrics();
			json(res, 200, lab.metrics());
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/reset") {
			await lab.reset();
			json(res, 200, await snapshot());
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/bump") {
			json(res, 200, { corpusVersion: lab.bumpCorpus(), state: await snapshot() });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/rerank-probe") {
			/**
			 * ④ 上线前的判别力自检 —— 直接用 SDK 的 `checkReranker`。
			 *
			 * **判据是 margin（正例最低 − 负例最高），不是跨度。** 先前这里自己算跨度，
			 * 那条判据比 SDK 那个弱一档：一个把「完全无关」打得比「同义改写」还高的模型
			 * （顺序整个反过来，毫无用处）只要分数摊得开就能过关。而 SDK 里那个函数
			 * 就在旁边，还带着 shouldMatch 标注 —— 同一件事没有理由做两遍、还做差一点。
			 */
			if (!encoders.reranker) {
				json(res, 200, { available: false, rows: [], margin: null, minMargin: MIN_RERANK_MARGIN, usable: false });
				return;
			}
			const probes = activeProbes();
			const report = await checkReranker(encoders.reranker, probes, MIN_RERANK_MARGIN);
			json(res, 200, {
				available: true,
				minMargin: MIN_RERANK_MARGIN,
				target: encoders.models.rerankTarget,
				rows: report.rows.map((r, i) => ({ ...r, a: probes[i].a, b: probes[i].b })),
				minPositive: report.minPositive,
				maxNegative: report.maxNegative,
				margin: report.margin,
				spread: report.spread,
				usable: report.usable,
				thetaQ: lab.defaults.thetaQ,
			});
			return;
		}
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found");
	} catch (err) {
		console.error(err);
		json(res, 500, { error: err instanceof Error ? err.message : String(err) });
	}
});

server.listen(PORT, () => {
	console.log(`\n语义缓存验证台  →  http://localhost:${PORT}\n`);
});

/**
 * 退出时关掉存储。**先前 `backing.close()` 从来没被调用过** —— 内存后端无所谓，
 * 但 pgvector 的连接池和 Redis 的客户端会把进程挂住，Ctrl-C 之后要等超时才退。
 */
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		if (closing) return;
		closing = true;
		server.close();
		void backing
			.close()
			.catch((err: unknown) => console.error("关闭存储时出错：", err))
			.finally(() => process.exit(0));
	});
}
