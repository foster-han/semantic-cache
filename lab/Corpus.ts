/**
 * 语料分发。**默认英文**；CORPUS_LANG=zh 切到中文那套（结构完全对应，可直接比较）。
 *
 * 两份都静态导入，运行期选一份 —— 动态 import 会让类型检查失去意义，
 * 而这套东西的价值有一半在契约上。
 */
import type { CourseCorpus } from "./types/Corpus.ts";
import * as CorpusEnModule from "./CorpusEn.ts";
import * as CorpusZhModule from "./CorpusZh.ts";

export const LANGUAGE: "zh" | "en" = process.env.CORPUS_LANG === "zh" ? "zh" : "en";

const active: CourseCorpus = LANGUAGE === "en" ? CorpusEnModule : CorpusZhModule;

export const {
	COURSE,
	DOCS,
	SYL_V2,
	ENTITIES,
	STUDENT_RECORDS,
	DISTRACTORS,
	SCENARIOS,
	RERANK_PROBES,
	compose,
	refineSuffix,
} = active;
