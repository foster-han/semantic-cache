/**
 * 抽一份 Quora Question Pairs（QQP）到本地。
 *
 * **为什么要它**：此前 ④ 的探针只有 18 对手工对子，我据此栽过两次
 * （3 对时说「中文全都不可用」，换 18 对后结论反过来；判据里混进 ④ 根本见不到
 * 的「完全无关」类）。QQP 是 40 万+ 真人独立写的问题对，带二元标签
 * （1 = 语义等价该命中，0 = 不等价该未命中）—— 那正是 ②③④ 要做的判断，
 * 也是 GPTCache 用的同一份数据。
 *
 * **它只覆盖问题侧**：QQP 是一对问题加一个标签，没有「资料」这一侧，所以
 * `CE_TARGET=answer` 那个形态（④ 拿旧答案当 candidate）在它上面标不了 ——
 * 那个形态的标定仍然留在课程语料上。
 *
 *   node --experimental-strip-types scripts/fetchQqp.ts [条数]
 *   QQP_BALANCE=0 ... 保留 QQP 原始正负比（约 37:63），不做均衡
 *   → data/qqp.json（.gitignore 掉，属于可重新下载的缓存）
 *
 * **两类指标对正例率的依赖方向相反**，所以均衡与否要跟着数据一起记下来：
 *   命中率 / 正确拒绝  各自只看一个标签的分母 —— 不受正例率影响
 *   正命中率(precision) 分母混了两类 —— **正例率越高它越好看**
 * 均衡到 50%（原始 37%）会让 precision 系统性偏乐观。默认仍是均衡（历史行为，
 * 而且命中率的方差小），但文件里记 `balanced`，读的人才知道手上这批是哪种。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "data", "qqp.json");
const WANT = Number(process.argv[2] ?? 2000);
const PAGE = 100; // datasets-server 单次上限

interface Row {
	readonly question1: string;
	readonly question2: string;
	readonly label: number;
}

/**
 * 按标签均衡取样，而不是顺序取前 N 条。
 *
 * QQP 的正负比约 37:63，顺序取会让正例偏少；而「该命中」那一类恰好是
 * 命中率的分母 —— 分母小，命中率的方差就大。
 *
 * 代价见文件头：precision 会偏乐观。`QQP_BALANCE=0` 保留原始比例。
 */
const BALANCED = process.env.QQP_BALANCE !== "0";
/** 均衡取样用的两个桶 */
const positives: Array<Row> = [];
const negatives: Array<Row> = [];
/**
 * 不均衡取样**必须按扫到的原始顺序存**，不能分桶后再合并 ——
 * 那样合出来是「先全部正例、再全部负例」，截断就只剩正例，正例率反而变成 100%。
 */
const natural: Array<Row> = [];
const half = Math.ceil(WANT / 2);

let offset = 0;
let total = Infinity;
while ((BALANCED ? positives.length < half || negatives.length < half : natural.length < WANT) && offset < total) {
	const url =
		`https://datasets-server.huggingface.co/rows?dataset=nyu-mll%2Fglue&config=qqp&split=validation` +
		`&offset=${offset}&length=${PAGE}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`拉取失败 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
	const body = (await res.json()) as { num_rows_total: number; rows: Array<{ row: Row }> };
	total = body.num_rows_total;
	for (const { row } of body.rows) {
		// 去掉过短或缺失的 —— 那些测的是分词器不是判别力
		if (row.question1.length < 8 || row.question2.length < 8) continue;
		const kept = { question1: row.question1, question2: row.question2, label: row.label };
		if (!BALANCED) {
			if (natural.length < WANT) natural.push(kept);
			continue;
		}
		const bucket = row.label === 1 ? positives : negatives;
		if (bucket.length < half) bucket.push(kept);
	}
	offset += PAGE;
	if (offset % 1000 === 0) {
		process.stdout.write(
			BALANCED
				? `  已扫 ${offset}/${total}　正 ${positives.length} 负 ${negatives.length}\n`
				: `  已扫 ${offset}/${total}　收 ${natural.length}/${WANT}\n`,
		);
	}
}

const pairs = BALANCED ? [...positives.slice(0, half), ...negatives.slice(0, half)] : natural;
const posCount = pairs.filter(p => p.label === 1).length;
const posRate = pairs.length === 0 ? 0 : posCount / pairs.length;
await mkdir(dirname(OUT), { recursive: true });
await writeFile(
	OUT,
	JSON.stringify(
		{ source: "nyu-mll/glue · qqp · validation", balanced: BALANCED, positiveRate: posRate, scanned: offset, pairs },
		null,
		"\t",
	),
	"utf8",
);
console.log(`\n写入 ${OUT}`);
console.log(`  ${pairs.length} 对：该命中 ${posCount}　该未命中 ${pairs.length - posCount}　正例率 ${(posRate * 100).toFixed(1)}%`);
console.log(
	BALANCED
		? "  ⚠ 已按标签均衡（QQP 原始约 37%）—— 正命中率(precision) 因此**偏乐观**，命中率与正确拒绝不受影响。要原始比例：QQP_BALANCE=0"
		: "  保留原始比例 —— precision 无偏，但正例少时命中率的方差偏大",
);
console.log(`  扫过 ${offset} 行（共 ${total}）`);
