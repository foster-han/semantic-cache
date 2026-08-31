import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createEncoders } from "./Models.ts";
import { createLab, DEFAULTS } from "./LabCache.ts";
import { createLabStore } from "./Store.ts";
import { COURSE, DOCS, SCENARIOS } from "./Corpus.ts";
import type { LabConfig } from "./types/LabConfig.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7788);

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

async function snapshot() {
	return {
		mode: encoders.mode,
		note: encoders.note,
		store: { kind: backing.kind, note: backing.note },
		generator: lab.generator,
		rerankAvailable: encoders.rerankAvailable,
		defaults: DEFAULTS,
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
		docs: lab.docs.map(d => ({ id: d.id, unit: d.unit, title: d.title, version: d.version })),
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
			// 重排器判别力自检：一个 cross-encoder 只有在「同义」和「完全无关」之间
			// 拉得开分数时才有用。拉不开就说明模型和任务不匹配。
			const PAIRS: ReadonlyArray<readonly [string, string, string]> = [
				["同义改写", "怎么重置密码？", "忘记密码了怎么办？"],
				["同主题不同问", "什么是递归？", "什么是闭包？"],
				["完全无关", "什么是递归？", "美国第 44 任总统是谁？"],
				["逐字相同", "什么是递归？", "什么是递归？"],
			];
			const rows: Array<{ tag: string; a: string; b: string; score: number | null }> = [];
			for (const [tag, a, b] of PAIRS) rows.push({ tag, a, b, score: await encoders.rerank(a, b) });
			const vals = rows.map(r => r.score).filter((v): v is number => typeof v === "number");
			const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : null;
			json(res, 200, {
				available: encoders.rerankAvailable,
				rows,
				spread,
				usable: spread !== null && spread >= 0.15,
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
