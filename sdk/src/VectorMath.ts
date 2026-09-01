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

/**
 * 归一化缓存键：折叠空白、统一大小写、去掉句末标点。
 *
 * **空白是折叠成一个空格，不是删掉。**先前是全删，那在中文里无害（分词本来就不确定），
 * 但在英文里会把 `what is over fitting` 和 `what is overfitting` 归成同一个 key ——
 * 而闸 ② 的全部价值恰恰是「零假命中风险」。
 *
 * 更麻烦的是这类合并**挡不住**：③ 的碰撞复核用的是同一个 `normalizeKey`，
 * 它只能抓哈希碰撞，抓不到归一化自己造成的合并。
 *
 * 折叠的代价是中文侧 ② 的容错变窄（`什么是 过拟合` 和 `什么是过拟合` 成了两个 key）。
 * 这个方向是安全的：② 漏掉就落到 ③，而 ③ 本来就是管「说法不同、意思相同」的那一层。
 * 反过来的错法（该分开的合并了）没有任何一层能兜住。
 */
export function normalizeKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/\s+/gu, " ")
		// 句末标点连同它前后的空白一起去掉，免得留下一个尾随空格
		.replace(/[\s?？。.!！]+$/u, "")
		.replace(/^\s+/u, "");
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
