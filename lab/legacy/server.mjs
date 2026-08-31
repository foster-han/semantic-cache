import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createEncoder } from "./models.mjs";
import { createLab, DEFAULTS } from "./LabCache.mjs";
import { COURSE, DOCS, SCENARIOS } from "./corpus.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7788);

const encoder = await createEncoder();
const lab = createLab(encoder);

console.log(`\n模型后端：${encoder.mode}　—　${encoder.note}`);
if (encoder.mode === "stub") {
	console.log("⚠  stub 模式的分数没有统计意义，只用来跑通控制流。真验证请用 MODE=local。");
}

function json(res, code, body) {
	const payload = JSON.stringify(body);
	res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
	res.end(payload);
}

async function readBody(req) {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return {};
	}
}

function snapshot() {
	return {
		mode: encoder.mode,
		note: encoder.note,
		rerankAvailable: encoder.rerankAvailable,
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
		cache: lab.cache.map(e => ({
			id: e.id,
			scope: e.scope,
			by: e.meta?.user ?? "—",
			prompt: e.matchText,
			sources: e.sourceIds,
			corpusVersion: e.sourceVersion,
		})),
		counters: lab.counters,
	};
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);

	try {
		if (req.method === "GET" && url.pathname === "/") {
			const html = await readFile(join(here, "public", "index.html"), "utf8");
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			return res.end(html);
		}

		if (req.method === "GET" && url.pathname === "/api/state") {
			return json(res, 200, snapshot());
		}

		if (req.method === "POST" && url.pathname === "/api/ask") {
			const body = await readBody(req);
			const result = await lab.ask(
				{ text: body.text ?? "", user: body.user ?? "s1", unit: body.unit ?? null },
				body.config ?? {},
			);
			// SDK 的返回值形状 → 验证台 UI 的形状
			return json(res, 200, {
				answer: result.answer,
				decision: result.outcome === "generated" ? "regenerate" : result.outcome === "refine" ? "tune" : "reuse",
				outcome: result.outcome,
				exitedAt: result.exitedAt,
				entryId: result.entryId,
				sourceIds: result.sourceIds,
				anonymized: result.request.display.anonymized,
				retrievalText: result.request.retrievalText,
				trace: result.trace,
				state: snapshot(),
			});
		}

		if (req.method === "POST" && url.pathname === "/api/bench") {
			const body = await readBody(req);
			const result = await lab.bench(body.config ?? {});
			return json(res, 200, { ...result, state: snapshot() });
		}

		if (req.method === "POST" && url.pathname === "/api/reset") {
			lab.reset();
			return json(res, 200, snapshot());
		}

		if (req.method === "POST" && url.pathname === "/api/bump") {
			const v = lab.bumpCorpus();
			return json(res, 200, { corpusVersion: v, state: snapshot() });
		}

		if (req.method === "POST" && url.pathname === "/api/rerank-probe") {
			// 重排器判别力自检。
			// 一个 cross-encoder 只有在「同义」和「完全无关」之间拉得开分数时才有用。
			// 拉不开就说明模型和任务不匹配（比如拿 query→passage 的相关性模型去比
			// query→query），这时候 bench 里 ④ 的任何数字都不可信。
			const PAIRS = [
				["同义改写", "怎么重置密码？", "忘记密码了怎么办？"],
				["同主题不同问", "什么是递归？", "什么是闭包？"],
				["完全无关", "什么是递归？", "美国第 44 任总统是谁？"],
				["逐字相同", "什么是递归？", "什么是递归？"],
			];
			const rows = [];
			for (const [tag, a, b] of PAIRS) rows.push({ tag, a, b, score: await encoder.rerank(a, b) });
			const vals = rows.map(r => r.score).filter(v => typeof v === "number");
			const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : null;
			return json(res, 200, {
				available: encoder.rerankAvailable,
				rows,
				spread,
				usable: spread !== null && spread >= 0.15,
			});
		}

		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found");
	} catch (err) {
		console.error(err);
		json(res, 500, { error: String(err?.message ?? err) });
	}
});

server.listen(PORT, () => {
	console.log(`\n语义缓存验证台  →  http://localhost:${PORT}\n`);
});
