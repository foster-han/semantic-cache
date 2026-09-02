/**
 * Minimal Redis interface.
 *
 * The SDK is dependency-free, so this **does not import `redis` or `ioredis`** — the caller passes
 * their own client in. node-redis's `sendCommand` already has this shape, so no adapter is needed:
 *
 *   const client = createClient({ url });
 *   await client.connect();
 *   createRedisVectorSetCacheStore({ redis: client, dimensions: { match: 384, answer: 384 } });
 *
 * For ioredis, wrap it: `{ sendCommand: args => client.call(args[0], ...args.slice(1)) }`.
 *
 * **Every argument is a string.** Vector components, timestamps and JSON are serialized inside the
 * store before being handed over — drivers differ in how they treat numbers and Buffers, and
 * letting that difference leak into a vector shows up as "recall order changed when we swapped
 * clients", which is among the hardest failures here to diagnose.
 */
export interface RedisExecutor {
	/** Send one command and return the driver's raw reply. */
	sendCommand(args: ReadonlyArray<string>): Promise<unknown>;
}
