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
 * 非有限分量在这里一次性拦下。**三个后端必须是同一种行为。**
 *
 * 先前 pgvector 抛错、Redis 把分量静默写成 `0`、内存原样存下 NaN —— 同一个坏掉的
 * 编码器在三个后端上三种症状，而内存那一种是**假命中**：NaN 进了 `cosine` 之后
 * 相似度是 NaN，而 ③ 的 `similarity < floor` 对 NaN 恒为 false，召回下限形同不存在，
 * 一个毫不相干的问题也能拿到复用。
 *
 * 选「抛」而不是「静默替换成 0」：编码器返回 NaN 是配置错误，不是能兜的输入 ——
 * 和上面 `cosine` 的维度检查同一族取舍，那里也不肯给一个没有意义的数。
 */
export function assertFiniteVector(name: string, vector: ReadonlyArray<number>): void {
	const bad = vector.findIndex(v => !Number.isFinite(v));
	if (bad === -1) return;
	throw new Error(
		`${name}第 ${bad} 维是 ${String(vector[bad])}，不是有限数。多半是编码器返回了 NaN —— ` +
			"零向量、空输入、维度不匹配的池化都会导致它，先查编码器而不是查这里。",
	);
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
