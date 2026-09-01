/**
 * 课程资料 → 判别力探针。
 *
 * 这里测的全是「不报错但标出错阈值」那一族：难负例被容易负例稀释、正例用模板凑出来、
 * 同一批资料两次跑出不同探针。三件事都不会抛，只会让 `calibratedOn` 变成一句假话。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { generateProbes } from "../src/ProbeGenerator.ts";
import type { ProbeSource } from "../src/types/ProbeGeneration.ts";

const COURSE: ReadonlyArray<ProbeSource> = [
	{ id: "n3", unit: "ch3", title: "L1 正则化" },
	{ id: "n4", unit: "ch3", title: "L2 正则化" },
	{ id: "n5", unit: "ch3", title: "过拟合" },
	{ id: "n8", unit: "ch5", title: "批归一化" },
	{ id: "n9", unit: "ch5", title: "残差连接" },
];

test("同章负例与跨章负例分档 —— 混在一起会把 margin 撑得虚宽", async () => {
	const report = await generateProbes(COURSE);
	// ch3 三篇两两配对 = 3 对，ch5 两篇 = 1 对
	assert.equal(report.counts.sibling, 4);
	// 3×2 跨章对子
	assert.equal(report.counts.distant, 6);
	for (const probe of report.probes) {
		if (probe.tier === "sibling") assert.equal(probe.shouldMatch, false);
		if (probe.tier === "distant") assert.equal(probe.shouldMatch, false);
	}
});

test("没有改写来源时一条正例都不造，而不是用模板凑", async () => {
	const report = await generateProbes(COURSE);
	assert.equal(report.counts.paraphrase, 0);
	assert.equal(report.usableFor.positives, false);
	assert.equal(report.usableFor.negatives, true);
	assert.match(report.warnings.join("\n"), /一条正例都没有/u);
	assert.match(report.warnings.join("\n"), /退回用标题当问句/u);
});

test("给了两条以上问法才造正例，并同时造出逐字相同那一档", async () => {
	const withQuestions = COURSE.map(s => ({
		...s,
		questions: [`什么是${s.title}？`, `${s.title}用来做什么？`],
	}));
	const report = await generateProbes(withQuestions);
	assert.equal(report.counts.paraphrase, 5);
	assert.equal(report.usableFor.positives, true);
	// 逐字相同是天花板检查，默认只取两对
	assert.equal(report.counts.identical, 2);
	for (const probe of report.probes) {
		if (probe.tier === "identical") assert.equal(probe.a, probe.b);
		if (probe.tier === "paraphrase") assert.notEqual(probe.a, probe.b);
	}
	assert.deepEqual(report.warnings, []);
});

test("phrasing 只在 questions 不够时才补，够了就不调用", async () => {
	const calls: Array<string> = [];
	const sources = [
		{ ...COURSE[0], questions: ["什么是 L1 正则化？", "L1 正则化怎么用？"] },
		{ ...COURSE[1] },
		{ ...COURSE[2] },
	];
	const report = await generateProbes(sources, {
		phrasing: async (concept, count) => {
			calls.push(concept);
			return Array.from({ length: count }, (_, i) => `${concept}的第${i + 1}种问法`);
		},
	});
	// 第一篇自带两条，不该被补
	assert.deepEqual(calls, ["L2 正则化", "过拟合"]);
	assert.equal(report.counts.paraphrase, 3);
});

test("同一批资料跑两次必须得到同一组探针 —— 否则 calibratedOn 是假话", async () => {
	const many: Array<ProbeSource> = Array.from({ length: 12 }, (_, i) => ({
		id: `d${i}`,
		unit: `ch${i % 2}`,
		title: `概念 ${i}`,
	}));
	const first = await generateProbes(many);
	const second = await generateProbes(many);
	assert.deepEqual(first.probes, second.probes);
	// 12 篇分两个 unit，同章对子共 30 对，被默认额度截到 20
	assert.equal(first.counts.sibling, 20);
});

test("每档额度可以单独调，难负例给得比容易负例多是默认", async () => {
	const report = await generateProbes(COURSE, { limits: { distant: 2 } });
	assert.equal(report.counts.distant, 2);
	assert.equal(report.counts.sibling, 4);
});

test("calibratedOn 由生成方给出，含正负例构成 —— 人手写的那句半年后一定对不上", async () => {
	const withQuestions = COURSE.map(s => ({ ...s, questions: [`什么是${s.title}？`, `${s.title}有什么用？`] }));
	const report = await generateProbes(withQuestions);
	assert.match(report.calibratedOn, /5 篇资料 \/ 2 个单元/u);
	assert.match(report.calibratedOn, /同章 4、跨章 6/u);
	assert.doesNotMatch(report.calibratedOn, /告警/u);
});

test("资料少于两篇、id 重复、问法数下限：三个都在构造期抛", async () => {
	await assert.rejects(() => generateProbes([COURSE[0]]), /至少需要两篇资料/u);
	await assert.rejects(() => generateProbes([COURSE[0], { ...COURSE[1], id: "n3" }]), /id 有 1 个重复/u);
	await assert.rejects(() => generateProbes(COURSE, { phrasingsPerConcept: 1 }), /造不出正例/u);
});

test("全部资料同属一个 unit 时要告警 —— 没有跨章对照就看不出 margin 的来源", async () => {
	const oneUnit = COURSE.map(s => ({ ...s, unit: "ch3", questions: [`什么是${s.title}？`, `${s.title}呢？`] }));
	const report = await generateProbes(oneUnit);
	assert.equal(report.counts.distant, 0);
	assert.match(report.warnings.join("\n"), /没有跨章负例/u);
});
