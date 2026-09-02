import type {
	GeneratedProbe,
	ProbeGenerationOptions,
	ProbeGenerationReport,
	ProbeSource,
	ProbeTier,
	QuestionPhrasing,
} from "./types/ProbeGeneration.ts";
import { hashKey } from "./VectorMath.ts";

/**
 * Generates discrimination probes from uploaded course material.
 *
 * Three rules drive every trade-off here:
 *
 * 1. **Hard negatives come from the same unit.** `L1 regularization` and `L2 regularization` share
 *    almost all their vocabulary and differ in meaning; a bi-encoder cannot separate that class to
 *    begin with. Cross-unit pairs are far easier, and mixing them in stretches the margin falsely
 *    wide — so they are kept in separate tiers, and the report is given per tier.
 * 2. **Positives cannot be templated.** "What is X" and "what does X mean" are nearly identical on
 *    the surface, any encoder clears them, and the resulting margin is fake. So with no paraphrase
 *    source, **no positives are generated**, and the report says plainly that this probe set can
 *    only detect half the problem.
 * 3. **Sampling must be deterministic.** Running twice over the same material has to produce the
 *    same probes, or "what were these thresholds calibrated on" means nothing. So the top N are
 *    taken by content-hash order, with no randomness.
 */

const DEFAULT_LIMITS: Readonly<Record<ProbeTier, number>> = {
	// A ceiling check; two pairs suffice — it should carry no information, and if it does the model
	// is broken.
	identical: 2,
	paraphrase: 12,
	// The real source of danger in this scenario, so it gets the largest quota.
	sibling: 20,
	distant: 8,
};

/**
 * Take the first `limit` items after a stable sort by content hash. **The same material necessarily
 * yields the same output, independently of argument order** — the caller has already fixed an order
 * by id; see the comment inside `generateProbes` for why.
 *
 * **The `key` separator must be a character that cannot occur in the text.** Joined with `|`,
 * `(a="x|y", b="z")` and `(a="x", b="y|z")` compute the same sort key. The result would **still** be
 * deterministic (JS's `Array.sort` has been stable since ES2019, so equal keys keep their relative
 * order), but that leans on a language-version guarantee to paper over an ambiguity that can simply
 * be removed.
 *
 * The same "join fields into one key" problem has far heavier consequences elsewhere: on
 * `flightKey` it is a wrong answer, on `composeScope` it is a cross-tenant read. **The two are
 * solved differently, deliberately** — `flightKey` lives only in-process, so a `\u0000` separator is
 * the cheapest thing that works; `composeScope` is stored and read by humans, so it escapes
 * instead. This is the `flightKey` kind, and uses the former.
 */
function takeStable<T>(items: ReadonlyArray<T>, limit: number, key: (item: T) => string): Array<T> {
	if (items.length <= limit) {
		return [...items];
	}
	return items
		.map(item => ({ item, order: hashKey(key(item)) }))
		.sort((x, y) => (x.order < y.order ? -1 : x.order > y.order ? 1 : 0))
		.slice(0, limit)
		.map(entry => entry.item);
}

/**
 * Collects the phrasings for each document.
 *
 * The order is: the caller's `questions` first (a teacher's FAQ or a log of past questions both beat
 * anything generated on the spot), topped up from `phrasing` when there are not enough. **Let
 * `phrasing` throw if it throws** — a course missing paraphrases for a few concepts produces skewed
 * probes, and that is not visible in the result. Retry policy is the caller's business.
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
		byDoc.set(
			source.id,
			[...new Set([...given, ...generated])].filter(q => q.trim() !== ""),
		);
	}
	return byDoc;
}

/** The sentence used to build a negative. With no phrasings it falls back to the title — valid for negatives only; positives never take this path. */
function negativeText(source: ProbeSource, questions: ReadonlyArray<string>): string {
	return questions[0] ?? source.title;
}

export async function generateProbes(
	sources: ReadonlyArray<ProbeSource>,
	options: ProbeGenerationOptions = {},
): Promise<ProbeGenerationReport> {
	if (sources.length < 2) {
		throw new Error(
			`Probe generation needs at least two documents, received ${sources.length} — a single document cannot form any negative pair.`,
		);
	}
	const duplicated = sources.length - new Set(sources.map(s => s.id)).size;
	if (duplicated > 0) {
		throw new Error(
			`${duplicated} duplicate document id(s). Ids are what a probe's aDoc/bDoc point at, and duplicates make gate ④'s question-to-answer self-check fetch the wrong answer.`,
		);
	}

	const perConcept = options.phrasingsPerConcept ?? 2;
	if (perConcept < 2) {
		throw new Error(
			`phrasingsPerConcept=${perConcept} cannot produce a positive: one concept needs at least two phrasings before "the same thing said differently" means anything.`,
		);
	}
	const limits = { ...DEFAULT_LIMITS, ...options.limits };
	/**
	 * **Fix an order by id first, then generate.**
	 *
	 * Negative pairs are formed as `i < j`, so argument order decides which of a pair is `a` and
	 * which is `b` — and `takeStable`'s sort key is `[tier, a, b]`. Upload the same material in a
	 * different order and every key changes, selecting **a different set** of probes (with 8
	 * same-chapter documents and a quota of 20, forward and reverse order select 20 pairs that
	 * barely overlap). "The same input necessarily yields the same output" would then hold only when
	 * the arrays match element for element — while calibration runs on exactly this probe set, so
	 * the thresholds would drift with upload order. Id uniqueness was checked above, so this is a
	 * total order.
	 */
	const ordered = [...sources].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const questions = await collectQuestions(ordered, options.phrasing, perConcept);

	const identical: Array<GeneratedProbe> = [];
	const paraphrase: Array<GeneratedProbe> = [];
	for (const source of ordered) {
		const phrasings = questions.get(source.id) ?? [];
		if (phrasings.length >= 1) {
			identical.push({
				label: `identical · ${source.title}`,
				a: phrasings[0],
				b: phrasings[0],
				shouldMatch: true,
				tier: "identical",
				aDoc: source.id,
				bDoc: source.id,
			});
		}
		// Positives come only from two phrasings that genuinely exist. Fewer than two means no pair;
		// nothing is filled in from a template.
		for (let i = 1; i < phrasings.length; i++) {
			paraphrase.push({
				label: `paraphrase · ${source.title}`,
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
	for (let i = 0; i < ordered.length; i++) {
		for (let j = i + 1; j < ordered.length; j++) {
			const [left, right] = [ordered[i], ordered[j]];
			const sameUnit = left.unit === right.unit;
			const probe: GeneratedProbe = {
				label: `${sameUnit ? "same unit, different concept" : "different unit"} · ${left.title} / ${right.title}`,
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

	function pick(tier: ProbeTier, pool: ReadonlyArray<GeneratedProbe>): Array<GeneratedProbe> {
		return takeStable(pool, limits[tier], p => [p.tier, p.a, p.b].join("\u0000"));
	}
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
			"Not a single positive: neither `questions` (two or more per document) nor a `phrasing` hook was supplied. " +
				'This probe set can only detect "negatives are not separable" (the source of false hits), not "positives are wrongly refused" (the source of hit rate thrown away) — ' +
				"a gate calibrated on it only ever gets stricter.",
		);
	}
	const titleFallback = sources.filter(s => (questions.get(s.id) ?? []).length === 0).length;
	if (titleFallback > 0) {
		warnings.push(
			`${titleFallback}/${sources.length} documents have no phrasings, so the negative side falls back to using the title as the question. ` +
				"Titles and the sentences students actually type are not the same distribution, so these pairs score optimistically.",
		);
	}
	if (counts.sibling === 0) {
		warnings.push(
			"No same-unit negatives: every document has a distinct unit, or there is only one. " +
				"Hard negatives (adjacent concepts within a unit) are the main source of false hits in this scenario, and without them the margin is falsely wide.",
		);
	}
	const units = new Set(sources.map(s => s.unit)).size;
	if (units === 1) {
		warnings.push(
			"Every document belongs to one unit, so there are no cross-unit negatives — there is no way to tell how much of the margin comes from the easy tier.",
		);
	}

	const calibratedOn =
		`auto probes · ${sources.length} documents / ${units} units · ` +
		`${counts.identical + counts.paraphrase} positives (identical ${counts.identical}, paraphrase ${counts.paraphrase}) + ` +
		`${counts.sibling + counts.distant} negatives (same unit ${counts.sibling}, cross unit ${counts.distant})` +
		(warnings.length > 0 ? ` · ⚠ ${warnings.length} warning(s)` : "");

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
