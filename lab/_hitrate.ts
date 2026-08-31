/**
 * 缺的那一半：**该命中的时候命中了吗。**
 *
 * 此前所有数字都是精度（假命中数）。但一个永远不命中的缓存假命中率天然是 0 ——
 * 精度达标和「有存在意义」是两件事。这里数三个量：
 *
 *   召回率  应该复用的 N 条里，实际复用了几条          ← 缓存有没有用
 *   精确率  实际复用的里面，有几条是对的                ← 复用得对不对
 *   假命中  实际复用但依据错了                          ← 之前唯一在测的
 */
import { createEncoders } from "./Models.ts";
import { createLab } from "./LabCache.ts";
import { SCENARIOS } from "./Corpus.ts";
import type { LabConfig } from "./types/LabConfig.ts";

const enc = await createEncoders();
const lab = createLab(enc);
const expectByKey = new Map(SCENARIOS.map(s => [s.key, s.expect]));

const CONFIGS: ReadonlyArray<readonly [string, Partial<LabConfig>]> = [
	["全闸打开", {}],
	["关掉 ⑥", { gate6: false }],
	["关掉 ④", { gate4: false }],
];

console.log(`编码器 ${enc.mode}　生成端 ${lab.generator.kind}\n`);
console.log("配置".padEnd(12), "该复用命中", "  该拦下正确", "  复用总数", "  假命中", "  说明");

for (const [tag, cfg] of CONFIGS) {
	const r = await lab.bench(cfg);
	let shouldReuse = 0;
	let didReuse = 0;
	let shouldBlock = 0;
	let didBlock = 0;
	let reuseTotal = 0;
	const missedHits: Array<string> = [];

	for (const row of r.rows) {
		const expect = expectByKey.get(row.key);
		const reused = row.got === "reuse";
		if (reused) reuseTotal += 1;
		if (expect === "reuse") {
			shouldReuse += 1;
			if (reused && row.ok) didReuse += 1;
			else missedHits.push(row.key);
		} else {
			shouldBlock += 1;
			if (!reused) didBlock += 1;
		}
	}
	const recall = shouldReuse === 0 ? 0 : didReuse / shouldReuse;
	console.log(
		`${tag.padEnd(12)} ${String(didReuse).padStart(4)}/${shouldReuse}  ${(recall * 100).toFixed(0).padStart(3)}%` +
			`   ${String(didBlock).padStart(4)}/${shouldBlock}` +
			`   ${String(reuseTotal).padStart(6)}` +
			`   ${String(r.falseHit).padStart(5)}` +
			`   ${missedHits.length ? `漏掉：${missedHits.join(" ")}` : "该命中的全命中了"}`,
	);
}
