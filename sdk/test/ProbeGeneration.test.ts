/**
 * Course sources to discrimination probes.
 *
 * Everything here belongs to the family that raises no error and calibrates the wrong threshold:
 * hard negatives diluted by easy ones, positives padded out of a template, the same sources
 * yielding different probes on two runs. None of the three throws; they only turn `calibratedOn`
 * into a lie.
 */

import { generateProbes } from "../src/ProbeGenerator.ts";
import type { ProbeSource } from "../src/types/ProbeGeneration.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const COURSE: ReadonlyArray<ProbeSource> = [
	{ id: "n3", unit: "ch3", title: "L1 正则化" },
	{ id: "n4", unit: "ch3", title: "L2 正则化" },
	{ id: "n5", unit: "ch3", title: "过拟合" },
	{ id: "n8", unit: "ch5", title: "批归一化" },
	{ id: "n9", unit: "ch5", title: "残差连接" },
];

test("same-chapter and cross-chapter negatives are separate tiers — blended, they inflate the margin", async () => {
	const report = await generateProbes(COURSE);
	// ch3's three sources pair up into 3, ch5's two into 1.
	assert.equal(report.counts.sibling, 4);
	// 3x2 cross-chapter pairs.
	assert.equal(report.counts.distant, 6);
	for (const probe of report.probes) {
		if (probe.tier === "sibling") {
			assert.equal(probe.shouldMatch, false);
		}
		if (probe.tier === "distant") {
			assert.equal(probe.shouldMatch, false);
		}
	}
});

test("with no paraphrase source no positives are fabricated, rather than padding from a template", async () => {
	const report = await generateProbes(COURSE);
	assert.equal(report.counts.paraphrase, 0);
	assert.equal(report.usableFor.positives, false);
	assert.equal(report.usableFor.negatives, true);
	assert.match(report.warnings.join("\n"), /Not a single positive/u);
	assert.match(report.warnings.join("\n"), /falls back to using the title as the question/u);
});

test("positives are built only once two or more phrasings are given, and the byte-identical tier is built alongside", async () => {
	const withQuestions = COURSE.map(s => ({
		...s,
		questions: [`什么是${s.title}？`, `${s.title}用来做什么？`],
	}));
	const report = await generateProbes(withQuestions);
	assert.equal(report.counts.paraphrase, 5);
	assert.equal(report.usableFor.positives, true);
	// Byte-identical is a ceiling check, and only two pairs are taken by default.
	assert.equal(report.counts.identical, 2);
	for (const probe of report.probes) {
		if (probe.tier === "identical") {
			assert.equal(probe.a, probe.b);
		}
		if (probe.tier === "paraphrase") {
			assert.notEqual(probe.a, probe.b);
		}
	}
	assert.deepEqual(report.warnings, []);
});

test("phrasing fills in only when questions are too few, and is never called once there are enough", async () => {
	const calls: Array<string> = [];
	const sources = [
		{ ...COURSE[0], questions: ["什么是 L1 正则化？", "L1 正则化怎么用？"] },
		{ ...COURSE[1] },
		{ ...COURSE[2] },
	];
	const report = await generateProbes(sources, {
		phrasing: (concept, count) => {
			calls.push(concept);
			return Promise.resolve(Array.from({ length: count }, (_, i) => `${concept}的第${i + 1}种问法`));
		},
	});
	// The first source brings two of its own and should not be filled in.
	assert.deepEqual(calls, ["L2 正则化", "过拟合"]);
	assert.equal(report.counts.paraphrase, 3);
});

test("the same sources run twice must yield the same probe set — otherwise calibratedOn is a lie", async () => {
	const many: Array<ProbeSource> = Array.from({ length: 12 }, (_, i) => ({
		id: `d${i}`,
		unit: `ch${i % 2}`,
		title: `概念 ${i}`,
	}));
	const first = await generateProbes(many);
	const second = await generateProbes(many);
	assert.deepEqual(first.probes, second.probes);
	// 12 sources across two units make 30 same-chapter pairs, cut to 20 by the default quota.
	assert.equal(first.counts.sibling, 20);
});

test("a different upload order must still yield the same probe set — otherwise the threshold drifts with upload order", async () => {
	/**
	 * Negative pairs are formed with `i < j`, so argument order decides which of a pair is `a` and
	 * which is `b` — and `takeStable`'s sort key is exactly `[tier, a, b]`. Passing the sources in
	 * reverse order used to select 20 same-chapter negatives that barely overlapped the forward
	 * order's, and that probe set is what calibration runs on.
	 */
	const many: Array<ProbeSource> = Array.from({ length: 8 }, (_, i) => ({
		id: `d${i}`,
		unit: "ch1",
		title: `概念 ${i}`,
		questions: [`什么是概念 ${i}？`, `概念 ${i} 怎么理解？`],
	}));
	const forward = await generateProbes(many);
	const reversed = await generateProbes([...many].reverse());
	// 8 same-chapter sources make 28 pairs, cut to 20 — and it must be the same 20.
	assert.equal(forward.counts.sibling, 20);
	const pairs = (r: Awaited<ReturnType<typeof generateProbes>>) =>
		r.probes.map(p => `${p.tier}:${p.aDoc}/${p.bDoc}`).sort();
	assert.deepEqual(pairs(forward), pairs(reversed));
	assert.deepEqual(forward.probes, reversed.probes, "连顺序都该一样：库自己先按 id 定序");
});

test("each tier's quota is tunable on its own, and more hard negatives than easy ones is the default", async () => {
	const report = await generateProbes(COURSE, { limits: { distant: 2 } });
	assert.equal(report.counts.distant, 2);
	assert.equal(report.counts.sibling, 4);
});

test("calibratedOn comes from the generator and names the positive and negative composition — a hand-written sentence is guaranteed to be stale in six months", async () => {
	const withQuestions = COURSE.map(s => ({ ...s, questions: [`什么是${s.title}？`, `${s.title}有什么用？`] }));
	const report = await generateProbes(withQuestions);
	assert.match(report.calibratedOn, /5 documents \/ 2 units/u);
	assert.match(report.calibratedOn, /same unit 4, cross unit 6/u);
	assert.doesNotMatch(report.calibratedOn, /告警/u);
});

test("fewer than two sources, duplicate ids, and a phrasing-count floor: all three throw at construction", async () => {
	await assert.rejects(() => generateProbes([COURSE[0]]), /needs at least two documents/u);
	await assert.rejects(() => generateProbes([COURSE[0], { ...COURSE[1], id: "n3" }]), /1 duplicate document id/u);
	await assert.rejects(() => generateProbes(COURSE, { phrasingsPerConcept: 1 }), /cannot produce a positive/u);
});

test("a warning when every source belongs to one unit — without a cross-chapter contrast the margin's origin is invisible", async () => {
	const oneUnit = COURSE.map(s => ({ ...s, unit: "ch3", questions: [`什么是${s.title}？`, `${s.title}呢？`] }));
	const report = await generateProbes(oneUnit);
	assert.equal(report.counts.distant, 0);
	assert.match(report.warnings.join("\n"), /there are no cross-unit negatives/u);
});
