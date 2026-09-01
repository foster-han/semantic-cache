import { hashKey } from "./VectorMath.ts";
import type {
	GeneratedProbe,
	ProbeGenerationOptions,
	ProbeGenerationReport,
	ProbeSource,
	ProbeTier,
	QuestionPhrasing,
} from "./types/ProbeGeneration.ts";

/**
 * 从上传的课程资料生成判别力探针。
 *
 * 三条规则决定了这里的所有取舍：
 *
 * 1. **难负例来自同一单元。**`L1 正则化` 与 `L2 正则化` 词汇几乎全重叠、意思不同，
 *    双编码器在这一类上本来就分不开。跨单元的对子容易得多，混在一起会把 margin
 *    撑得虚宽 —— 所以按档分开，报告也按档给。
 * 2. **正例不能靠模板造。**「什么是 X」和「X 是什么意思」在字面上几乎相同，任何
 *    编码器都能过，标出来的 margin 是假的。所以没有改写来源时**不造正例**，
 *    并在报告里说清楚这组探针只能检出一半的问题。
 * 3. **取样必须确定。**同一批资料跑两次要得到同一组探针，否则「这个阈值标在什么
 *    上面」这句话就没有意义。所以按内容哈希排序取前 N，不用随机数。
 */

const DEFAULT_LIMITS: Readonly<Record<ProbeTier, number>> = {
	// 天花板检查，两对足够 —— 它不该有信息量，有就是模型坏了
	identical: 2,
	paraphrase: 12,
	// 这个场景真正的危险来源，给最多的额度
	sibling: 20,
	distant: 8,
};

/** 按内容哈希稳定排序后取前 `limit` 条。同一批输入必然得到同一组输出。 */
function takeStable<T>(items: ReadonlyArray<T>, limit: number, key: (item: T) => string): Array<T> {
	if (items.length <= limit) return [...items];
	return items
		.map(item => ({ item, order: hashKey(key(item)) }))
		.sort((x, y) => (x.order < y.order ? -1 : x.order > y.order ? 1 : 0))
		.slice(0, limit)
		.map(entry => entry.item);
}

/**
 * 收集每篇资料的问法。
 *
 * 顺序是：调用方给的 `questions` 优先（老师的 FAQ、历史提问日志都比现生成的准），
 * 不够再用 `phrasing` 补。**`phrasing` 抛错就让它抛** —— 一门课少了几个概念的改写，
 * 标出来的探针就偏，而这件事从结果上看不出来。重试策略是调用方的事。
 */
async function collectQuestions(
	sources: ReadonlyArray<ProbeSource>,
	phrasing: QuestionPhrasing | undefined,
	perConcept: number,
): Promise<Map<string, Array<string>>> {
	const byDoc = new Map<string, Array<string>>();
	for (const source of sources) {
		const given = [...new Set(source.questions ?? [])].filter(q => q.trim() !== "");
		if (given.length >= perConcept || phrasing === undefined) {
			byDoc.set(source.id, given);
			continue;
		}
		const generated = await phrasing(source.title, perConcept - given.length, source);
		byDoc.set(source.id, [...new Set([...given, ...generated])].filter(q => q.trim() !== ""));
	}
	return byDoc;
}

/** 造负例时用的那一句。没有问法就退回标题 —— 只对负例成立，正例不走这条路。 */
function negativeText(source: ProbeSource, questions: ReadonlyArray<string>): string {
	return questions[0] ?? source.title;
}

export async function generateProbes(
	sources: ReadonlyArray<ProbeSource>,
	options: ProbeGenerationOptions = {},
): Promise<ProbeGenerationReport> {
	if (sources.length < 2) {
		throw new Error(`探针生成至少需要两篇资料，收到 ${sources.length} 篇 —— 一篇资料造不出任何负例对。`);
	}
	const duplicated = sources.length - new Set(sources.map(s => s.id)).size;
	if (duplicated > 0) {
		throw new Error(`资料 id 有 ${duplicated} 个重复。id 是探针里 aDoc/bDoc 的指向，重复会让 ④ 的问↔答自检取到错的答案。`);
	}

	const perConcept = options.phrasingsPerConcept ?? 2;
	if (perConcept < 2) {
		throw new Error(`phrasingsPerConcept=${perConcept} 造不出正例：一个概念至少要两种问法，才谈得上「同一件事的不同说法」。`);
	}
	const limits = { ...DEFAULT_LIMITS, ...options.limits };
	const questions = await collectQuestions(sources, options.phrasing, perConcept);

	const identical: Array<GeneratedProbe> = [];
	const paraphrase: Array<GeneratedProbe> = [];
	for (const source of sources) {
		const phrasings = questions.get(source.id) ?? [];
		if (phrasings.length >= 1) {
			identical.push({
				label: `逐字相同 · ${source.title}`,
				a: phrasings[0],
				b: phrasings[0],
				shouldMatch: true,
				tier: "identical",
				aDoc: source.id,
				bDoc: source.id,
			});
		}
		// 正例只从真实存在的两种问法来。凑不出两条就没有这一对，不用模板补
		for (let i = 1; i < phrasings.length; i++) {
			paraphrase.push({
				label: `同义改写 · ${source.title}`,
				a: phrasings[0],
				b: phrasings[i],
				shouldMatch: true,
				tier: "paraphrase",
				aDoc: source.id,
				bDoc: source.id,
			});
		}
	}

	const sibling: Array<GeneratedProbe> = [];
	const distant: Array<GeneratedProbe> = [];
	for (let i = 0; i < sources.length; i++) {
		for (let j = i + 1; j < sources.length; j++) {
			const [left, right] = [sources[i], sources[j]];
			const sameUnit = left.unit === right.unit;
			const probe: GeneratedProbe = {
				label: `${sameUnit ? "同章不同概念" : "跨章"} · ${left.title} ／ ${right.title}`,
				a: negativeText(left, questions.get(left.id) ?? []),
				b: negativeText(right, questions.get(right.id) ?? []),
				shouldMatch: false,
				tier: sameUnit ? "sibling" : "distant",
				aDoc: left.id,
				bDoc: right.id,
			};
			(sameUnit ? sibling : distant).push(probe);
		}
	}

	const pick = (tier: ProbeTier, pool: ReadonlyArray<GeneratedProbe>): Array<GeneratedProbe> =>
		takeStable(pool, limits[tier], p => `${p.tier}|${p.a}|${p.b}`);
	const chosen: Record<ProbeTier, Array<GeneratedProbe>> = {
		identical: pick("identical", identical),
		paraphrase: pick("paraphrase", paraphrase),
		sibling: pick("sibling", sibling),
		distant: pick("distant", distant),
	};
	const counts: Record<ProbeTier, number> = {
		identical: chosen.identical.length,
		paraphrase: chosen.paraphrase.length,
		sibling: chosen.sibling.length,
		distant: chosen.distant.length,
	};

	const warnings: Array<string> = [];
	if (counts.paraphrase === 0) {
		warnings.push(
			"一条正例都没有：既没给 questions（每篇两条以上），也没接 phrasing。" +
				"这组探针只能检出「负例分不开」（假命中的来源），检不出「正例被误拒」（命中率白掉的来源）—— " +
				"拿它标出来的闸只会越标越严。",
		);
	}
	const titleFallback = sources.filter(s => (questions.get(s.id) ?? []).length === 0).length;
	if (titleFallback > 0) {
		warnings.push(
			`${titleFallback}/${sources.length} 篇资料没有问法，负例那一侧退回用标题当问句。` +
				"标题和学生真会打出来的句子不是同一个分布，这批对子的分数偏乐观。",
		);
	}
	if (counts.sibling === 0) {
		warnings.push(
			"没有同章负例：所有资料的 unit 互不相同，或只有一篇。" +
				"难负例（同章相邻概念）恰好是这个场景假命中的主要来源，缺了它 margin 会虚宽。",
		);
	}
	const units = new Set(sources.map(s => s.unit)).size;
	if (units === 1) {
		warnings.push("所有资料同属一个 unit，没有跨章负例 —— 无法判断 margin 里有多少来自容易那一档。");
	}

	const calibratedOn =
		`自动探针 · ${sources.length} 篇资料 / ${units} 个单元 · ` +
		`${counts.identical + counts.paraphrase} 正例（逐字 ${counts.identical}、改写 ${counts.paraphrase}）+ ` +
		`${counts.sibling + counts.distant} 负例（同章 ${counts.sibling}、跨章 ${counts.distant}）` +
		(warnings.length > 0 ? ` · ⚠ ${warnings.length} 条告警` : "");

	return {
		probes: [...chosen.identical, ...chosen.paraphrase, ...chosen.sibling, ...chosen.distant],
		counts,
		usableFor: {
			negatives: counts.sibling + counts.distant > 0,
			positives: counts.paraphrase > 0,
		},
		calibratedOn,
		warnings,
	};
}
