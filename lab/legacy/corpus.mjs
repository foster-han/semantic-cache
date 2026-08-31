/**
 * 语料分发。CORPUS_LANG=en 切到英文那套（结构完全对应，可直接比较）。
 */
const LANG = process.env.CORPUS_LANG === "en" ? "en" : "zh";
const mod = LANG === "en" ? await import("./corpus.en.mjs") : await import("./corpus.zh.mjs");

export const LANGUAGE = LANG;
export const { COURSE, DOCS, SYL_V2, ENTITIES, STUDENT_RECORDS, DISTRACTORS, SCENARIOS } = mod;
