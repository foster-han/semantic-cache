export function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
	if (a.length !== b.length) {
		throw new Error(
			`Vector dimensions differ (${a.length} vs ${b.length}) — most likely the outputs of two model roles were mixed. ` +
				"Recall vectors must come from PairEncoder.embedQuestions.",
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
 * Non-finite components are stopped here, once. **All three backends must behave identically.**
 *
 * Previously pgvector threw, Redis silently wrote the component as `0`, and in-memory stored the
 * NaN as-is — one broken encoder, three symptoms across three backends, and the in-memory one is a
 * **false hit**: a NaN reaching `cosine` makes the similarity NaN, and gate ③'s `similarity < floor`
 * is always false for NaN, so the recall floor effectively does not exist and a completely
 * unrelated question can be reused.
 *
 * Throwing rather than silently substituting 0: an encoder returning NaN is a configuration error,
 * not an input that can be absorbed — the same family of trade-off as the dimension check above,
 * which likewise refuses to invent a meaningless number.
 */
export function assertFiniteVector(name: string, vector: ReadonlyArray<number>): void {
	const bad = vector.findIndex(v => !Number.isFinite(v));
	if (bad === -1) {
		return;
	}
	throw new Error(
		`${name} dimension ${bad} is ${String(vector[bad])}, not a finite number. Most likely the encoder returned NaN — ` +
			"a zero vector, empty input, or pooling with mismatched dimensions all cause it, so check the encoder rather than here.",
	);
}

/**
 * Normalizes a cache key: collapse whitespace, fold case, drop trailing sentence punctuation.
 *
 * **Whitespace is collapsed to one space, not deleted.** It used to be deleted entirely, which is
 * harmless in Chinese (word segmentation is indeterminate anyway) but in English merges
 * `what is over fitting` and `what is overfitting` into one key — while the entire value of gate ②
 * is that it carries zero risk of a false hit.
 *
 * Worse, such a merge **cannot be caught downstream**: gate ③'s collision re-check uses this same
 * `normalizeKey`, so it can catch a hash collision but not a merge that normalization itself
 * created.
 *
 * The cost of collapsing is narrower tolerance for gate ② on the Chinese side (`什么是 过拟合` and
 * `什么是过拟合` become two keys). That direction is the safe one: what ② misses falls through to
 * ③, and ③ is the layer for "different wording, same meaning" in the first place. The opposite
 * mistake — merging what should have stayed apart — has no layer that can absorb it.
 */
export function normalizeKey(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/\s+/gu, " ")
			// Trailing sentence punctuation goes together with the whitespace around it, so no
			// trailing space is left behind.
			.replace(/[\s?？。.!！]+$/u, "")
			.replace(/^\s+/u, "")
	);
}

/** Stable hash, for cache keys only — not for security purposes. */
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
