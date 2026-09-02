/** One retrieved source chunk. `id` is for the caller's own display and logging — the library never stores it. */
export interface Chunk {
	readonly id: string;
	readonly text: string;
	/** Optional score the caller already has. Used only for display ordering; the library does not rely on it. */
	readonly score?: number;
}

/**
 * The caller's own RAG retrieval. The library does not implement retrieval, it only calls this.
 *
 * **What arrives here must be the entity-preserving original text** (see `CachePrompt.retrievalText`).
 * If anonymized text is retrieved instead, two different people retrieve the same chunks.
 *
 * **The result must be sorted by descending relevance**, with `[0]` being the chunk this answer
 * would most be based on. Nothing in the library reads that order any more — it is handed to
 * `Generate` as-is — but generation itself almost always leans on the first chunk, so an unordered
 * set produces answers built on an arbitrary chunk with nothing raising an error. If your retrieval
 * layer returns an unordered set, sort it here before handing it over.
 */
export interface Retriever {
	retrieve(retrievalText: string, context: Readonly<Record<string, string>>): Promise<Array<Chunk>>;
}
