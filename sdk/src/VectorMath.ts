export function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
	if (a.length !== b.length) {
		throw new Error(
			`向量维度不一致（${a.length} vs ${b.length}）—— 多半是把两个模型角色的输出混用了。` +
				`回答向量必须来自 RetrievalEncoder.embedPassage，召回向量必须来自 PairEncoder.embedQuestions。`,
		);
	}
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}

/** 归一化缓存键：去空白、统一大小写、去掉句末标点。 */
export function normalizeKey(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/\s+/gu, "")
		.replace(/[?？。.!！]+$/u, "");
}

/** 稳定哈希，仅用于缓存键，不用于安全用途。 */
export function hashKey(text: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
	}
	return `${h1.toString(36)}${h2.toString(36)}`;
}
