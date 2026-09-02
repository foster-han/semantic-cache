import type { ProbePair } from "../DiscriminationCheck.ts";

/**
 * Generates discrimination probes automatically from uploaded course material.
 *
 * **Why this is needed: hand-written probes do not survive contact with a product.** The lab's
 * `RERANK_PROBES` were written by hand against one course, whereas in the real thing you know
 * neither what a teacher will upload nor what a student will ask. No probes means no calibration,
 * and without calibration `calibratedOn` is an empty promise — exactly what this type design
 * exists to prevent.
 *
 * There is one thing you can do: **the moment material is uploaded, the corpus is already in
 * hand.** Both "must be reused" and "must be refused" groups can be constructed from it without
 * waiting for a single student request.
 */

/**
 * One uploaded document. Probe generation needs no more than this.
 *
 * **The body text is not taken.** Building a question needs the concept (`title`) and which unit it
 * belongs to (`unit`); body text would only turn this into a second retrieval implementation. To
 * paraphrase from body text, read it on the `QuestionPhrasing` side.
 */
export interface ProbeSource {
	readonly id: string;
	/**
	 * Chapter / unit. **It determines negative difficulty; it is not metadata.**
	 *
	 * Two concepts inside one unit (`L1 regularization` and `L2 regularization`) overlap heavily in
	 * vocabulary and differ in meaning — precisely the class a bi-encoder cannot separate and gate ④
	 * exists for. Two concepts from different units are easy negatives. A threshold calibrated on
	 * the two tiers mixed together gets loosened by the easy ones.
	 */
	readonly unit: string;
	/** The concept this document covers, used to form the sentence a student would ask. */
	readonly title: string;
	/**
	 * Known phrasings for this concept. **Two or more are required before a positive can be built.**
	 *
	 * They can come from a teacher-written FAQ, a log of past questions, or `QuestionPhrasing`
	 * generating them on the spot. Left empty, generation falls back to using `title` as the
	 * question — which is only enough for negatives; see `ProbeGenerationReport.warnings`.
	 */
	readonly questions?: ReadonlyArray<string>;
}

/**
 * Turns one concept into several phrasings a student might use.
 *
 * **The product already has an LLM; this is where it plugs in.** Supplied by the caller, like
 * `Generate`: this layer does not choose a generator and ships no question templates — templated
 * "different phrasings" are nearly identical on the surface, any encoder clears them, and the
 * resulting margin is falsely wide. Better no positives than fake ones.
 */
export type QuestionPhrasing = (concept: string, count: number, source: ProbeSource) => Promise<ReadonlyArray<string>>;

/**
 * Probe difficulty tier. **The order is decreasing difficulty, and that order is meaningful.**
 *
 * The report is broken down by tier because "separable overall" is misleading: easy negatives
 * stretch the margin open, while the tier that actually produces false hits is `sibling`. Looking
 * only at the total margin hides that.
 */
export type ProbeTier =
	/** Positive · byte-identical. A ceiling check — failing this tier means the model or pooling is misconfigured. */
	| "identical"
	/** Positive · different phrasings of one concept. */
	| "paraphrase"
	/** Negative · different concepts within one unit. **Hard negatives, the real source of danger here.** */
	| "sibling"
	/** Negative · different concepts across units. Easy negatives. */
	| "distant";

export interface GeneratedProbe extends ProbePair {
	readonly tier: ProbeTier;
	readonly aDoc: string;
	/**
	 * Which document the `b` side should be based on.
	 *
	 * A gate ④ self-check running `target: "answer"` needs that document's answer as the candidate —
	 * probes have to follow the form. Calibrating a question-to-answer gate with question-to-question
	 * probes computes fine and is not the same scale.
	 */
	readonly bDoc: string;
}

export interface ProbeGenerationOptions {
	/** Without it, and without two or more `ProbeSource.questions`, not a single positive can be built. */
	readonly phrasing?: QuestionPhrasing;
	/** How many phrasings to take per concept. Default 2 — the minimum for one positive pair. */
	readonly phrasingsPerConcept?: number;
	/**
	 * Maximum pairs per tier. The default favours `sibling`: pairing a course's documents is O(n²),
	 * taking all of them neither finishes nor helps, and hard negatives are the tier this scenario
	 * should be testing most.
	 */
	readonly limits?: Partial<Record<ProbeTier, number>>;
}

export interface ProbeGenerationReport {
	readonly probes: ReadonlyArray<GeneratedProbe>;
	readonly counts: Readonly<Record<ProbeTier, number>>;
	/**
	 * What this probe set can detect. **Both must be true before it can calibrate a threshold.**
	 *
	 * With negatives only, it can detect "negatives are not separable" (the source of false hits)
	 * and cannot detect "positives are wrongly refused" (the source of hit rate thrown away).
	 * A gate calibrated on such probes only ever gets stricter.
	 */
	readonly usableFor: {
		readonly negatives: boolean;
		readonly positives: boolean;
	};
	/**
	 * A sentence ready to drop into `Calibrated.calibratedOn`.
	 *
	 * That field is required, and a hand-written sentence is certain to be out of date in six
	 * months — having the generator produce it is what keeps "what were these thresholds calibrated
	 * on" from diverging from the probes actually used.
	 */
	readonly calibratedOn: string;
	/** Where this probe set is weak. Only an empty array means no known problems. */
	readonly warnings: ReadonlyArray<string>;
}
