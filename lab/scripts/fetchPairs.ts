/**
 * 从 `redis/langcache-sentencepairs-v1` 取一个 config 到本地。
 *
 * **为什么要多个数据集**：QQP 上得到的两条结论只在一份数据上量过 ——「③ 换微调编码器
 * 提升五倍」和「④ 两个现成重排器都进不了高精度区」。而 QQP 的分布有已知偏差：问句干净、
 * 没有错别字口语、负例大多是完全不同的两个问题。
 *
 * 换几份分布不同的重跑之后，第一条**作废**了：那个五倍是 in-domain 优势
 * （`langcache-embed-v1` 就是在 QQP 上微调的），out-of-domain 只剩 −2.3 ~ +14 个点。
 * 第二条站住了，而且多出一条更有用的：④ 的价值取决于负例类型（paws 上 +18 个点、
 * pit2015 上负收益）。**换数据集是为了知道结论是关于打分器的还是关于那一份数据的。**
 *
 * 这个 collection 是 Redis 为语义缓存做的（Apache-2.0），几个 config 正好覆盖 QQP 缺的：
 *   paws      对抗性高词汇重叠（实体互换、词序调换）—— ④ 真正会面对的那类负例
 *   pit2015   Twitter 短文本，噪声大、口语，**原始正例率只有 14%**
 *   all       多来源混合，最接近真实部署的多样性
 *
 * **默认保留原始正例率，不均衡。** 均衡会让正命中率(precision) 偏乐观，而这一轮的
 * 目的是验证不是对照 —— 要无偏的那个数。`BALANCE=1` 可切回均衡。
 *
 * **取样跨整个 split 撒页，不是顺序取前 N 行。** 顺序取过一次，结果是：`all` config
 * 按 source 分块排列（offset 0~5000+ 全是 paws，30000 才到 qqp，60000 是 sick），
 * 取前 800 行拿到的 800 对**逐条等于 paws 那一份** —— 一份自称「多来源混合」的数据
 * 其实是另一份的副本，而两边的指标一模一样才让人发现。页按固定 seed 随机选，
 * 所以仍然可复现；`SAMPLE_SEED=` 可换一份。
 *
 *   node --experimental-strip-types scripts/fetchPairs.ts <config> [条数]
 *   → data/langcache-<config>.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATASET = "redis/langcache-sentencepairs-v1";
const CONFIG = process.argv[2];
const WANT = Number(process.argv[3] ?? 800);
const BALANCED = process.env.BALANCE === "1";
const PAGE = 100;

if (!CONFIG) {
	console.error("用法：fetchPairs.ts <config> [条数]　config 例：paws / pit2015 / all / qqp");
	process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "data", `langcache-${CONFIG}.json`);

interface Row {
	readonly sentence1: string;
	readonly sentence2: string;
	readonly label: number;
}

/** 固定 seed 的 LCG —— 取样要随机覆盖整个 split，但换台机器得拿到同一份 */
const SEED = Number(process.env.SAMPLE_SEED ?? 20260831);
let rngState = SEED;
function rnd(): number {
	rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
	return rngState / 0x7fffffff;
}

/**
 * 拉一页，**带退避重试**。
 *
 * datasets-server 会限流，而且限流时返回的是一整页 HTML 而不是 JSON —— 先前直接抛，
 * 错误消息里塞进 HTML 头把状态码顶掉了，看起来像解析失败而不是被限流。
 * 连着拉几个 config 就会撞上，一次静默失败让一份数据停留在旧版本上，
 * 而那件事是靠「两个数据集的指标一模一样」才发现的。
 */
async function fetchPage(offset: number, attempt = 0): Promise<{ total: number; rows: Array<Row & { source?: string }> }> {
	const url =
		`https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}` +
		`&config=${encodeURIComponent(CONFIG)}&split=test&offset=${offset}&length=${PAGE}`;
	const res = await fetch(url);
	const ct = res.headers.get("content-type") ?? "";
	if (res.ok && ct.includes("json")) {
		const body = (await res.json()) as { num_rows_total: number; rows: Array<{ row: Row & { source?: string } }> };
		return { total: body.num_rows_total, rows: body.rows.map(r => r.row) };
	}
	const why = res.ok ? `返回了 ${ct || "未知类型"} 而不是 JSON（多半是限流页）` : `HTTP ${res.status}`;
	if (attempt < 4) {
		const waitMs = 2000 * 2 ** attempt;
		process.stdout.write(`  ⚠ offset ${offset} ${why}，${waitMs / 1000}s 后重试（第 ${attempt + 1} 次）\n`);
		await new Promise(r => setTimeout(r, waitMs));
		return fetchPage(offset, attempt + 1);
	}
	throw new Error(
		`offset ${offset} 连续 5 次失败：${why}。datasets-server 限流了 —— 隔几分钟再跑，` +
			"或者调小条数。**别把半份数据当成完整的用**：这个脚本失败就不写文件，旧文件原样留着。",
	);
}

const natural: Array<Row> = [];
const positives: Array<Row> = [];
const negatives: Array<Row> = [];
const half = Math.ceil(WANT / 2);
const sources: Record<string, number> = {};

// 先探一页拿总行数，据此决定顺序全取还是跨 split 撒页
const probe = await fetchPage(0);
const total = probe.total;
const pageCount = Math.max(1, Math.floor(total / PAGE));
const needPages = Math.ceil((BALANCED ? WANT * 3 : WANT) / PAGE);
/**
 * split 本身不够大就顺序全取（撒页没有意义，还会漏行）；够大就随机撒页。
 * 阈值取「要的页数的两倍」—— 再密就等于顺序取了。
 */
const spread = pageCount > needPages * 2;
const offsets: Array<number> = [];
if (spread) {
	const picked = new Set<number>();
	while (picked.size < Math.min(needPages, pageCount)) picked.add(Math.floor(rnd() * pageCount) * PAGE);
	offsets.push(...[...picked].sort((a, b) => a - b));
} else {
	for (let o = 0; o < total; o += PAGE) offsets.push(o);
}
process.stdout.write(
	`  ${CONFIG}：共 ${total} 行，${spread ? `跨 split 随机撒 ${offsets.length} 页（seed ${SEED}）` : `顺序全取 ${offsets.length} 页`}\n`,
);

let scanned = 0;
for (const offset of offsets) {
	if (!BALANCED && natural.length >= WANT) break;
	if (BALANCED && positives.length >= half && negatives.length >= half) break;
	const page = offset === 0 ? probe : await fetchPage(offset);
	scanned += page.rows.length;
	for (const row of page.rows) {
		// 太短的测的是分词器不是判别力
		if (row.sentence1.length < 8 || row.sentence2.length < 8) continue;
		const kept = { sentence1: row.sentence1, sentence2: row.sentence2, label: row.label };
		if (!BALANCED) {
			if (natural.length >= WANT) break;
			natural.push(kept);
		} else {
			const bucket = row.label === 1 ? positives : negatives;
			if (bucket.length >= half) continue;
			bucket.push(kept);
		}
		// all config 带 source —— 记下实际拿到的分布，这是上面那个坑的直接防呆
		if (row.source) sources[row.source] = (sources[row.source] ?? 0) + 1;
	}
}

const pairs = BALANCED ? [...positives.slice(0, half), ...negatives.slice(0, half)] : natural;
const posCount = pairs.filter(p => p.label === 1).length;
const posRate = pairs.length === 0 ? 0 : posCount / pairs.length;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(
	OUT,
	JSON.stringify(
		{
			source: `${DATASET} · ${CONFIG} · test`,
			balanced: BALANCED,
			positiveRate: posRate,
			note: BALANCED
				? "按标签均衡 —— 正命中率(precision) 偏乐观，命中率与正确拒绝不受影响"
				: "保留原始正例率 —— precision 无偏。这才是这个 config 真实的分布",
			sampling: spread ? `跨 split 随机撒页（seed ${SEED}）` : "顺序全取",
			sources: Object.keys(sources).length > 0 ? sources : undefined,
			scanned,
			pairs,
		},
		null,
		"\t",
	),
	"utf8",
);
console.log(`写入 ${OUT}`);
console.log(`  ${pairs.length} 对：该命中 ${posCount}　该未命中 ${pairs.length - posCount}　正例率 ${(posRate * 100).toFixed(1)}%（${BALANCED ? "均衡" : "原始"}）`);
if (Object.keys(sources).length > 0) {
	console.log(`  来源分布：${Object.entries(sources).map(([k, v]) => `${k} ${v}`).join("　")}`);
}
