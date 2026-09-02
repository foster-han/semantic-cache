/**
 * 从 vCache 的四份语义缓存基准里取一份到本地。
 *
 * **为什么是这一份数据**：`data/` 里已有的四份全是句对，只够测「两句话像不像」。
 * 它们答不了两个问题 ——「复用的那个答案对不对」（要等价组标注）和「线上流量长什么样」
 * （QQP 的问句太干净，pit2015 又是推特）。vCache 这几份基准两样都给：
 *
 *   lmarena         51147 条 LM Arena 真实聊天 prompt，3500 个等价组（平均 14.6 条/组），
 *                   带 gpt-4o-mini 与 gpt-4.1-nano 的**真答案和真生成耗时**
 *   search          150000 条真实浏览器搜索查询，带等价组
 *   classification  37836 条分类任务，**没有等价组列** —— 判据只能落回比答案字符串
 *   combo           27500 条，前两份混合并**故意掺进「不该命中」的条目**
 *
 * 等价组标注就是判据本身，这不是猜的，是 vCache 自己 `benchmarks/benchmark.py` 里的：
 *
 *     label_id_set = data_entry.get("id_set", -1) or data_entry.get("ID_Set", -1)
 *     cache_response_correct = label_id_set == response_metadata.id_set
 *
 * 有了它，验证台上那句「这里没有『正命中率』：那要知道复用的答案对不对，线上没有这个
 * 信息」在这份数据上第一次不成立 —— 命中一条不同组的条目就是假命中，直接可算。
 *
 * Apache-2.0。数据集：https://huggingface.co/datasets/vCache
 * 代码与判据：https://github.com/vcache-project/vCache
 *
 *   node --experimental-strip-types scripts/fetchVCache.ts <基准> [条数]
 *   → data/vcache-<基准>.json
 *
 * 环境变量：
 *   SAMPLE_SEED   取样 seed，换一个就是另一份样本（默认 20260902）
 *   VCACHE_RESP   保留哪些答案列：first（默认）/ all / none
 *   VCACHE_EMB    保留哪些预算向量：none（默认）/ all / 逗号分隔如 gte,e5_large_v2
 *   VCACHE_DELAY_MS  每页之间歇多久（默认 1200）—— 匿名调用限流很紧，一口气拉三十页必 429
 *   HF_TOKEN      有就带上，限流额度高得多（`hf auth login` 之后在 ~/.cache/huggingface/token）
 *
 * **向量默认不留。** 留两列就是每行 ~11 KB，2000 行 22 MB —— 那个量级不该跟
 * `data/` 里那几份 150~750 KB 的凭据混在一起。要跑 ③ 的编码器横评时再显式打开，
 * 并且自己决定那份文件进不进版本库。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 四份基准。`label` 那一列各自叫什么名字是**实测出来的，不是猜的** —— classification 那份根本没有。 */
const BENCHMARKS = {
	lmarena: { dataset: "vCache/SemBenchmarkLmArena", rows: 51147 },
	search: { dataset: "vCache/SemBenchmarkSearchQueries", rows: 150000 },
	classification: { dataset: "vCache/SemBenchmarkClassification", rows: 37836 },
	combo: { dataset: "vCache/SemBenchmarkCombo", rows: 27500 },
} as const;

type BenchmarkName = keyof typeof BENCHMARKS;

/**
 * 预算向量对应的真实模型。**列名不等于模型 id**，而这个仓库的每张表都是按
 * (模型 id × pooling) 认的 —— 写下来是为了以后有人拿这些数去跟 `scores.json` 比时，
 * 知道比的是不是同一个东西。`_ft` 两列是 vCache 里那个 `BerkeleyEmbedding` 基线用的
 * 微调版（`benchmark.py`：`berkeley_embedding_model = EmbeddingModel.GTE_FT`）。
 */
const EMB_MODELS: Record<string, string> = {
	"text-embedding-3-large": "OpenAI text-embedding-3-large（3072 维，上游已归一化）",
	"text-embedding-3-small": "OpenAI text-embedding-3-small（1536 维，上游已归一化）",
	gte: "Alibaba-NLP/gte-large-en-v1.5（1024 维）",
	gte_ft: "同上，微调版 —— vCache 的 BerkeleyEmbedding 基线",
	e5_large_v2: "intfloat/e5-large-v2（1024 维）",
	e5_large_v2_ft: "同上，微调版",
	e5_mistral_7b: "intfloat/e5-mistral-7b-instruct（4096 维）",
};

/** search 那份的 response 列不是答案，是这句占位串。当成答案用就是拿一句常量去比对。 */
const PLACEHOLDER_RESPONSE = "Not required for the benchmark because of the id_set";

const NAME = process.argv[2] as BenchmarkName | undefined;
const WANT = Number(process.argv[3] ?? 2000);
const RESP_MODE = process.env.VCACHE_RESP ?? "first";
const DELAY_MS = Number(process.env.VCACHE_DELAY_MS ?? 1200);
const HF_TOKEN = process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN ?? "";
const EMB_MODE = process.env.VCACHE_EMB ?? "none";
const PAGE = 100;

if (!NAME || !(NAME in BENCHMARKS)) {
	console.error(`用法：fetchVCache.ts <基准> [条数]　基准：${Object.keys(BENCHMARKS).join(" / ")}`);
	process.exit(1);
}

const { dataset } = BENCHMARKS[NAME];
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "data", `vcache-${NAME}.json`);

/** 固定 seed 的 LCG —— 和 `fetchPairs.ts` 同一套：随机覆盖整个 split，但换台机器拿到同一份 */
const SEED = Number(process.env.SAMPLE_SEED ?? 20260902);
let rngState = SEED;
function rnd(): number {
	rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
	return rngState / 0x7fffffff;
}

interface Page {
	readonly total: number;
	readonly rows: Array<Record<string, unknown>>;
}

/**
 * 拉一页，带退避重试。**限流时 datasets-server 返回的是 HTML 而不是 JSON**，
 * 直接抛会把状态码淹在 HTML 头里，看起来像解析失败 —— 这个坑 `fetchPairs.ts` 踩过，
 * 这里照抄它的处置。
 *
 * **但退避阶梯不能照抄。** `fetchPairs.ts` 那套是 2/4/8/16 秒共 30 秒，而
 * datasets-server 的匿名限流是按分钟算的：实测连拉三十页之后一路 429，30 秒退避
 * 一次都没等回来，整轮白跑（好在失败不落盘）。这里的阶梯最长等到 2 分钟，
 * 并且**成功也要歇** —— 不歇就是在等下一个 429。
 *
 * lmarena 每行约 150 KB（六组预算向量占满），一页 100 行就是 15 MB。
 * 慢是慢，但**没有更省的路**：datasets-server 的 `columns=` 参数对这份数据不生效，
 * `/filter` 端点直接 500。
 */
const BACKOFF_MS = [3000, 10000, 30000, 60000, 120000, 120000];

async function fetchPage(offset: number, attempt = 0): Promise<Page> {
	const url =
		`https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}` +
		`&config=default&split=train&offset=${offset}&length=${PAGE}`;
	const res = await fetch(url, HF_TOKEN === "" ? undefined : { headers: { authorization: `Bearer ${HF_TOKEN}` } });
	const ct = res.headers.get("content-type") ?? "";
	if (res.ok && ct.includes("json")) {
		const body = (await res.json()) as { num_rows_total: number; rows: Array<{ row: Record<string, unknown> }> };
		return { total: body.num_rows_total, rows: body.rows.map(r => r.row) };
	}
	const why = res.ok ? `返回了 ${ct || "未知类型"} 而不是 JSON（多半是限流页）` : `HTTP ${res.status}`;
	if (attempt < BACKOFF_MS.length) {
		// 服务端说了等多久就听它的，没说才用阶梯
		const retryAfter = Number(res.headers.get("retry-after") ?? "");
		const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BACKOFF_MS[attempt];
		process.stdout.write(`  ⚠ offset ${offset} ${why}，${waitMs / 1000}s 后重试（第 ${attempt + 1} 次）\n`);
		await new Promise(r => setTimeout(r, waitMs));
		return fetchPage(offset, attempt + 1);
	}
	throw new Error(
		`offset ${offset} 连续 ${BACKOFF_MS.length + 1} 次失败：${why}。限流的话隔几分钟再跑，` +
			`或者设 HF_TOKEN，或者调大 VCACHE_DELAY_MS（当前 ${DELAY_MS}）。` +
			"**别把半份数据当成完整的用**：这个脚本失败就不写文件，旧文件原样留着。",
	);
}

/** `emb_gte` → `gte`，`emb_gte_lat` 不算向量列 */
function embName(column: string): string | null {
	if (!column.startsWith("emb_") || column.endsWith("_lat")) return null;
	return column.slice("emb_".length);
}

/** `response_gpt-4o-mini` → 是答案列；`_lat` 结尾的是耗时，另算 */
function isResponse(column: string): boolean {
	return column.startsWith("response_") && !column.endsWith("_lat");
}

function parseVector(raw: unknown): Array<number> {
	if (Array.isArray(raw)) return raw as Array<number>;
	if (typeof raw === "string") return JSON.parse(raw) as Array<number>;
	throw new Error(`向量列不是数组也不是字符串：${typeof raw}`);
}

// ---------------------------------------------------------------------------

const probe = await fetchPage(0);
const columns = Object.keys(probe.rows[0] ?? {});
const total = probe.total;

/**
 * 等价组那一列。lmarena / combo 叫 `ID_Set`，search 叫 `id_set`，
 * **classification 两个都没有** —— 那时判据只能落回比答案字符串，脚本如实报出来，
 * 不假装有一个空的标注列。
 */
const labelColumn = columns.includes("ID_Set") ? "ID_Set" : columns.includes("id_set") ? "id_set" : null;

const allEmb = columns.map(embName).filter((n): n is string => n !== null);
const keepEmb =
	EMB_MODE === "all" ? allEmb : EMB_MODE === "none" ? [] : EMB_MODE.split(",").map(s => s.trim()).filter(Boolean);
for (const name of keepEmb) {
	if (!allEmb.includes(name)) throw new Error(`这份基准没有 emb_${name} 这一列。有的是：${allEmb.join("、") || "（一列都没有）"}`);
}

const allResp = columns.filter(isResponse);
const keepResp = RESP_MODE === "all" ? allResp : RESP_MODE === "none" ? [] : allResp.slice(0, 1);

const pageCount = Math.max(1, Math.floor(total / PAGE));
const needPages = Math.ceil(WANT / PAGE);
/** split 够大就跨 split 撒页；不够大就顺序全取 —— 撒页在小 split 上没有意义还会漏行 */
const spread = pageCount > needPages * 2;
const offsets: Array<number> = [];
if (spread) {
	const picked = new Set<number>();
	while (picked.size < Math.min(needPages, pageCount)) picked.add(Math.floor(rnd() * pageCount) * PAGE);
	offsets.push(...[...picked].sort((a, b) => a - b));
} else {
	for (let o = 0; o < total; o += PAGE) offsets.push(o);
}

process.stdout.write(`  ${NAME}：${dataset} 共 ${total} 行\n`);
process.stdout.write(`  标注列 ${labelColumn ?? "（无 —— 只能比答案字符串）"}　答案列 ${keepResp.join("、") || "（不留）"}　向量 ${keepEmb.join("、") || "（不留）"}\n`);
process.stdout.write(
	`  ${spread ? `跨 split 随机撒 ${offsets.length} 页（seed ${SEED}）` : `顺序全取 ${offsets.length} 页`}` +
		`　每页间歇 ${DELAY_MS}ms${HF_TOKEN === "" ? "　（无 HF_TOKEN，走匿名额度）" : "　（带 HF_TOKEN）"}\n`,
);

interface Item {
	id: unknown;
	label: number | null;
	/**
	 * search 那份的 `cluster_id`。实测它是 `id_set` 的**前缀**（位数不固定：
	 * id_set 5231 → cluster 523，id_set 1572516 → cluster 15725），也就是
	 * **比等价组粗一档的分组**。500 行样本里 id_set 给 9 对同组、cluster 给 22 对，
	 * 多出来的那 13 对是「话题挨着但不等价」—— 正是 ④ 该拦住的那种近似。留着。
	 */
	cluster?: number;
	prompt: string;
	responses?: Record<string, string>;
	latencies?: Record<string, number>;
	emb?: Record<string, Array<number>>;
}

const items: Array<Item> = [];
/** 归一化前的原始范数区间 —— 写进文件，是为了让「这份到底动过没有」可查 */
const normRange: Record<string, [number, number]> = {};
let scanned = 0;
/**
 * 哪些答案列整列都是占位串。**不管留不留都要数** —— `VCACHE_RESP=none` 取的文件
 * 若不记这一笔，看起来就跟「这份基准本来就没有答案」一样，而那两件事对 ④ 的
 * 问↔答形态是完全不同的处境。
 */
const placeholderCounts: Record<string, number> = {};

for (const offset of offsets) {
	if (items.length >= WANT) break;
	if (offset !== 0 && DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
	const page = offset === 0 ? probe : await fetchPage(offset);
	scanned += page.rows.length;
	for (const row of page.rows) {
		if (items.length >= WANT) break;
		const prompt = String(row.prompt ?? "");
		if (prompt.length < 8) continue; // 太短的测的是分词器，不是判别力
		const item: Item = {
			id: row.id,
			label: labelColumn === null ? null : Number(row[labelColumn]),
			prompt,
		};
		if (row.cluster_id !== undefined && row.cluster_id !== null) item.cluster = Number(row.cluster_id);
		for (const col of allResp) {
			if (String(row[col] ?? "") === PLACEHOLDER_RESPONSE) placeholderCounts[col] = (placeholderCounts[col] ?? 0) + 1;
		}
		if (keepResp.length > 0) {
			item.responses = {};
			item.latencies = {};
			for (const col of keepResp) {
				item.responses[col] = String(row[col] ?? "");
				const lat = row[`${col}_lat`];
				if (lat !== undefined && lat !== null) item.latencies[col] = Number(lat);
			}
		}
		if (keepEmb.length > 0) {
			item.emb = {};
			for (const name of keepEmb) {
				const vec = parseVector(row[`emb_${name}`]);
				/**
				 * **入库时归一化，并把原始范数区间写进元数据。**
				 *
				 * `PairEncoder` 的契约是归一化向量，而 gte / e5 那几列上游的范数是 21~23
				 * （OpenAI 那两列才是 1.0）。不归一化不会报错 —— 余弦照样算得出来，
				 * 只是量在另一个尺度上，而 `recallFloor` 那个阈值是在归一化尺度上标的。
				 * 这正是这个仓库一路在防的那种「出错也不报错」。
				 */
				let sum = 0;
				for (const x of vec) sum += x * x;
				const norm = Math.sqrt(sum);
				const range = normRange[name];
				normRange[name] = range === undefined ? [norm, norm] : [Math.min(range[0], norm), Math.max(range[1], norm)];
				// 6 位小数：余弦在 1e-6 上的差远低于任何一个阈值的分辨率，而文件小一半
				item.emb[name] = norm === 0 ? vec : vec.map(x => Number((x / norm).toFixed(6)));
			}
		}
		items.push(item);
	}
}

/**
 * 组结构统计。**这一段不是装饰，是落盘的前提条件。**
 *
 * 撒页取样会把等价组打散：lmarena 平均 14.6 条/组散在 51147 行里，随机抽 N 行的
 * 同组对数约 C(N,2)×13.6/51147 —— 抽太少就一对正例都没有，而脚本此时仍然会
 * 成功写盘。那是「半份数据当成完整的用」的另一种形态，所以算出来，为零就拒绝落盘。
 */
const byLabel = new Map<number, number>();
let negativeLabels = 0;
for (const it of items) {
	if (it.label === null) continue;
	/**
	 * combo 里出现 `ID_Set` 为负（-1 / -2 / -7）。README 说那是「不该命中」的条目，
	 * 但 `benchmark.py` 只把 `-1` 当缺失、其余照常做等值比较 —— 抽样里 `-7` 那组
	 * 四条 prompt 的答案各不相同，按那条判据会互相算成「正确命中」。
	 * **上游语义没查实，所以不当等价组统计**，只记个数。
	 */
	if (it.label < 0) {
		negativeLabels += 1;
		continue;
	}
	byLabel.set(it.label, (byLabel.get(it.label) ?? 0) + 1);
}
let inGroupPairs = 0;
let rowsWithPartner = 0;
let largestGroup = 0;
for (const n of byLabel.values()) {
	inGroupPairs += (n * (n - 1)) / 2;
	if (n > 1) rowsWithPartner += n;
	largestGroup = Math.max(largestGroup, n);
}

if (labelColumn !== null && inGroupPairs === 0) {
	throw new Error(
		`这一份样本里一对同组的都没有（${items.length} 行落在 ${byLabel.size} 个组里）—— ` +
			"拿它测不了「该复用」那一侧，等于只有负例。加大条数再跑，或者换个 SAMPLE_SEED。**不写文件。**",
	);
}
/**
 * 同组对数随条数**平方**增长（组是被撒页打散的），所以「再多抓一点」的收益比直觉大得多：
 * 已知这一份的组密度之后，要 k 倍的对子只需要 √k 倍的条数。低产出时把这句话算出来，
 * 省得下次还得自己推 —— 也省得有人拿着 1 对正例的样本去下结论。
 */
const LOW_YIELD = 50;
if (labelColumn !== null && inGroupPairs < LOW_YIELD) {
	const need = Math.ceil(items.length * Math.sqrt(LOW_YIELD / inGroupPairs));
	process.stdout.write(
		`  ⚠ 同组对数只有 ${inGroupPairs} —— 正例这一侧太薄，别拿它下结论。` +
			`按当前组密度，要到 ${LOW_YIELD} 对大约需要 ${need} 行。\n`,
	);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(
	OUT,
	JSON.stringify(
		{
			source: `${dataset} · default · train`,
			license: "Apache-2.0",
			benchmark: NAME,
			labelColumn,
			labelNote:
				labelColumn === null
					? "这份基准没有等价组列 —— 判据只能落回比答案字符串，别假装有标注"
					: "同一个 label 就是语义等价：命中一条不同 label 的条目就是假命中。判据取自 vCache benchmark.py",
			/**
			 * search 那份的标签是**搜索日志聚出来的，不是人判的**，实测有明显噪声：
			 * 同一个 id_set 里出现过 `bank of america routing number mn` 与
			 * `bank of america new mexico routing number`（两个州）、
			 * `call of duty black ops 2` 与 `every call of duty game`。
			 * 拿它算出来的「假命中」因此是**相对这份标注**的，不等于人会判错 ——
			 * 这一条不写进文件，下一个人就会把它当成人工标注集来引用。
			 */
			labelNoise:
				NAME === "search"
					? "标签来自搜索日志聚类，非人工标注，实测有明显噪声（同组里混进过不同州、不同作品）—— 假命中率是相对这份标注的数，别当人判的"
					: undefined,
			sampling: spread ? `跨 split 随机撒页（seed ${SEED}）` : "顺序全取",
			scanned,
			rows: items.length,
			groups: {
				total: byLabel.size,
				largest: largestGroup,
				rowsWithPartner,
				inGroupPairs,
				negativeLabels: negativeLabels > 0 ? negativeLabels : undefined,
			},
			responses: keepResp.length > 0 ? keepResp : undefined,
			responsesArePlaceholders:
				Object.keys(placeholderCounts).length > 0
					? { counts: placeholderCounts, of: items.length, text: PLACEHOLDER_RESPONSE }
					: undefined,
			/**
			 * 丢了哪些答案列、为什么。**不写这一行，一份 `VCACHE_RESP=none` 取的文件
			 * 看起来就跟「这份基准本来就没有答案」一模一样** —— 而这两件事对
			 * ④ 的问↔答形态是完全不同的处境。
			 */
			responsesOmitted:
				keepResp.length < allResp.length
					? { columns: allResp.filter(c => !keepResp.includes(c)), why: `VCACHE_RESP=${RESP_MODE}` }
					: undefined,
			embeddings:
				keepEmb.length > 0
					? Object.fromEntries(
							keepEmb.map(name => [
								name,
								{
									model: EMB_MODELS[name] ?? "（未知，上游没标）",
									dims: items[0]?.emb?.[name]?.length ?? 0,
									normalized: true,
									rawNormRange: normRange[name],
									rounded: "6 位小数",
								},
							]),
						)
					: undefined,
			items,
		},
		null,
		"\t",
	),
	"utf8",
);

console.log(`写入 ${OUT}`);
console.log(`  ${items.length} 行　扫过 ${scanned} 行`);
if (labelColumn !== null) {
	console.log(
		`  ${byLabel.size} 个等价组　最大 ${largestGroup} 条　${rowsWithPartner} 行有同组伙伴（${((rowsWithPartner / items.length) * 100).toFixed(0)}%）　同组对数 ${inGroupPairs}`,
	);
	if (negativeLabels > 0) console.log(`  ⚠ ${negativeLabels} 行 label 为负 —— 上游语义未查实，没当等价组统计`);
}
for (const [col, n] of Object.entries(placeholderCounts)) {
	console.log(`  ⚠ ${col} 有 ${n}/${items.length} 行是占位串「${PLACEHOLDER_RESPONSE}」—— 这一列不是答案，判据只能靠 label`);
}
for (const name of keepEmb) {
	const [lo, hi] = normRange[name] ?? [0, 0];
	console.log(`  emb_${name}：已归一化（原始范数 ${lo.toFixed(2)}~${hi.toFixed(2)}）　${EMB_MODELS[name] ?? ""}`);
}
