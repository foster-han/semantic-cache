/**
 * 最小 Redis 接口。
 *
 * SDK 是零依赖的，所以这里**不 import `redis` / `ioredis`** —— 由调用方把自己的
 * 客户端传进来。node-redis 的 `sendCommand` 天然就是这个形状，不用写适配器：
 *
 *   const client = createClient({ url });
 *   await client.connect();
 *   createRedisVectorSetCacheStore({ redis: client, dimensions: { match: 384, answer: 384 } });
 *
 * ioredis 包一层：`{ sendCommand: args => client.call(args[0], ...args.slice(1)) }`。
 *
 * **参数一律是字符串。** 向量分量、时间戳、JSON 都在 store 里序列化好再交出去 ——
 * 各家驱动对 number 与 Buffer 的处理不一样，让那点差异漏进向量里，
 * 表现出来会是"换个客户端召回顺序就变了"，是这套东西最难查的一类失效。
 */
export interface RedisExecutor {
	/** 发一条命令，返回驱动给出的原始回复 */
	sendCommand(args: ReadonlyArray<string>): Promise<unknown>;
}
