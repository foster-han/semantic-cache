/**
 * 内存 vs 真库：同一份场景集、同一套阈值，两种存储后端跑出来的结果必须逐行一致。
 * 真库那一侧是 pgvector 还是 Redis，由环境变量决定，脚本本身不认识具体是哪个。
 *
 * 这是「换存储不改判定」这句话的可执行版本。判定逻辑在 SDK 里，存储只是接口的
 * 若干实现，所以任何差异都不是"实现风格不同"，而是有一边错了 —— 最可能的两处：
 * 召回排序（pgvector 的 `1 - (v <=> q)`、Redis 的 `2 * score - 1`，都必须等于
 * `VectorMath.cosine`）、过期过滤（必须在库内做，不能捞回来在应用层筛，
 * LIMIT / COUNT 会先生效）。
 *
 *   OUT=/tmp/x.json npm run compare-stores   # 顺便把内存侧结果存成基线
 */
import { writeFile } from "node:fs/promises";
import { createMemoryCacheStore } from "../../sdk/src/index.ts";
import { createLab, type LabBenchReport } from "../LabCache.ts";
import { createEncoders } from "../Models.ts";
import { createLabStore } from "../Store.ts";
import type { LabConfig } from "../types/LabConfig.ts";

const CONFIGS: ReadonlyArray<readonly [string, Partial<LabConfig>]> = [
	["全闸打开", {}],
	["关掉 ⑥", { gate6: false }],
	["关掉 ⑤", { gate5: false }],
	["关掉 ④", { gate4: false }],
	["关掉 preAnon", { preAnonRetrieval: false }],
	["scope=unit", { scopeMode: "unit" }],
	["① 门控打开", { gate1: true }],
];

/** 只比会影响结论的字段。答案原文里有拼接顺序，不参与比对。 */
function fingerprint(report: LabBenchReport): string {
	return JSON.stringify({
		rejected: report.rejected ?? false,
		total: report.total,
		falseHit: report.falseHit,
		missed: report.missed,
		rows: report.rows.map(r => [r.key, r.ok, r.got, r.primarySource, r.exitedAt]),
	});
}

const encoders = await createEncoders();
const [probeMatch] = await encoders.embedQuestions(["dimension probe"]);
const [probeAnswer] = await encoders.embedPassage(["dimension probe"]);
const dimensions = { match: probeMatch.length, answer: probeAnswer.length };

const backing = await createLabStore({ dimensions });
if (backing.kind === "memory") {
	throw new Error("这个脚本要内存之外的后端也在。请设 SEMCACHE_DB 或 SEMCACHE_REDIS，或直接用 npm run compare-stores / compare-stores:redis。");
}

const memoryLab = createLab(encoders, createMemoryCacheStore());
const realLab = createLab(encoders, backing.store);

console.log(`模型 ${encoders.mode}　存储 ${backing.note}\n`);
console.log("配置".padEnd(16), "内存 假命中/通过", `  ${backing.kind} 假命中/通过`.padEnd(20), "  一致");

const results: Record<string, LabBenchReport> = {};
let mismatched = 0;
for (const [label, cfg] of CONFIGS) {
	const mem = await memoryLab.bench(cfg);
	// 显式把真库交给 bench —— 不传它就跑在一次性内存缓存上，这个脚本会变成自己跟自己比
	const real = await realLab.bench(cfg, backing.store);
	results[label] = mem;
	const same = fingerprint(mem) === fingerprint(real);
	if (!same) mismatched += 1;
	const memCell = `${mem.falseHit}/${mem.total - mem.falseHit - mem.missed}`;
	const realCell = `${real.falseHit}/${real.total - real.falseHit - real.missed}`;
	console.log(label.padEnd(16), memCell.padStart(14), realCell.padStart(20), same ? "      ✓" : "      ✗ 不一致");
	if (!same) {
		for (let i = 0; i < mem.rows.length; i++) {
			const a = mem.rows[i];
			const b = real.rows[i];
			if (!b || a.ok !== b.ok || a.got !== b.got || a.primarySource !== b.primarySource || a.exitedAt !== b.exitedAt) {
				console.log(
					`    ${a.key}: 内存 ok=${a.ok} got=${a.got} src=${a.primarySource} exit=${a.exitedAt}` +
						` | pg ok=${b?.ok} got=${b?.got} src=${b?.primarySource} exit=${b?.exitedAt}`,
				);
			}
		}
	}
}

if (process.env.OUT) {
	await writeFile(process.env.OUT, JSON.stringify(results, null, "\t"), "utf8");
	console.log(`\n内存侧结果已写入 ${process.env.OUT}`);
}

await backing.close();
console.log(mismatched === 0 ? "\n全部一致 —— 换存储不改判定。" : `\n${mismatched} 个配置不一致。`);
process.exit(mismatched === 0 ? 0 : 1);
