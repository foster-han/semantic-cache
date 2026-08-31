/**
 * 存储后端的选择。**内存、pgvector 和 Redis 之间只差一个环境变量。**
 *
 * 默认内存：`npm run stub` 要能零依赖秒起，这是验证台的一条硬要求。
 * 给了连接串就走真库 —— 判定逻辑一行不变，`SemanticCache` 只认 `CacheStore` 接口，
 * 所以三种后端跑出来的场景集结果应当完全一致。**这本身就是一条可验证的断言。**
 */
import { createRequire } from "node:module";
import {
	createMemoryCacheStore,
	createPgVectorCacheStore,
	createRedisVectorSetCacheStore,
	type InspectableCacheStore,
	type RedisExecutor,
	type SqlExecutor,
} from "../sdk/src/index.ts";

export type LabStoreKind = "memory" | "pgvector" | "redis";

export interface LabStoreHandle {
	readonly store: InspectableCacheStore;
	readonly kind: LabStoreKind;
	readonly note: string;
	close(): Promise<void>;
}

/** `pg` 的连接池，只取这里真正用到的那部分形状。 */
interface PgPool extends SqlExecutor {
	end(): Promise<void>;
}

/** node-redis 的客户端，同样只取用到的那部分。 */
interface RedisClient extends RedisExecutor {
	connect(): Promise<unknown>;
	close(): Promise<void>;
}

/**
 * `pg` 是可选依赖：不接真库的人不该被迫装它，所以这里在运行时才解析。
 *
 * 用 `createRequire` 而不是 `await import("pg")`：pg 是 CJS，且整包挂在
 * `module.exports` 上，ESM 具名导出探测拿不到 `Pool`，只能走 default，
 * 而那又要求打开 esModuleInterop。这条路两个 tsconfig 都不用改。
 */
function loadPgPool(connectionString: string): PgPool {
	const require = createRequire(import.meta.url);
	let mod: { Pool: new (config: { connectionString: string }) => PgPool };
	try {
		mod = require("pg") as { Pool: new (config: { connectionString: string }) => PgPool };
	} catch (err) {
		throw new Error(
			`设置了 SEMCACHE_DB 但没装 pg。先 npm install，或者不设这个变量走内存后端。原始错误：${String(err)}`,
		);
	}
	return new mod.Pool({ connectionString });
}

/**
 * node-redis 同样是可选依赖。这里用 `await import`，不用 `createRequire` ——
 * 它是原生 ESM 且规规矩矩地具名导出 `createClient`，pg 那条注释里的理由不适用。
 */
async function loadRedisClient(url: string): Promise<RedisClient> {
	let mod: { createClient: (config: { url: string }) => RedisClient };
	try {
		mod = (await import("redis")) as unknown as { createClient: (config: { url: string }) => RedisClient };
	} catch (err) {
		throw new Error(
			`设置了 SEMCACHE_REDIS 但没装 redis。先 npm install，或者不设这个变量走内存后端。原始错误：${String(err)}`,
		);
	}
	const client = mod.createClient({ url });
	await client.connect();
	return client;
}

export interface LabStoreOptions {
	/** 两个向量列的维度，从编码器上量出来 —— 写死会让召回悄悄退化 */
	readonly dimensions: { readonly match: number; readonly answer: number };
	/** 注入时钟，供一致性测试构造「已过期」条目 */
	readonly now?: () => number;
}

/**
 * `STORE` 显式指定优先；没指定就看给了哪个连接串。
 * 两个都给了以 Redis 为准 —— 但这多半是配错了，所以直接说出来。
 */
function pickKind(pg: string | undefined, redis: string | undefined, requested: string | undefined): LabStoreKind {
	if (requested === "memory" || requested === "pgvector" || requested === "redis") return requested;
	if (requested !== undefined) {
		throw new Error(`STORE=${requested} 无法识别。只能是 memory / pgvector / redis。`);
	}
	if (redis !== undefined && pg !== undefined) {
		throw new Error("SEMCACHE_DB 和 SEMCACHE_REDIS 同时设了，说不清该走哪个。用 STORE= 明确指定一个。");
	}
	if (redis !== undefined) return "redis";
	if (pg !== undefined) return "pgvector";
	return "memory";
}

export async function createLabStore(options: LabStoreOptions): Promise<LabStoreHandle> {
	const pgUrl = process.env.SEMCACHE_DB;
	const redisUrl = process.env.SEMCACHE_REDIS;
	const kind = pickKind(pgUrl, redisUrl, process.env.STORE);
	const ann = process.env.SEMCACHE_ANN === "1";

	/**
	 * 默认表名/命名空间**带上维度**。
	 *
	 * 不带的话 stub（256 维）和真模型（384 维）会抢同一张表：先跑一次
	 * `npm run compare-stores`（stub）把表建成 256 维，之后 `npm run start:pg`
	 * 就在启动时被维度守卫拦死。守卫没错——两个向量空间的条目本来就不能堆在一起——
	 * 错的是让它们默认同名。显式给 SEMCACHE_TABLE / SEMCACHE_NS 仍然完全覆盖。
	 */
	const dims =
		options.dimensions.match === options.dimensions.answer
			? String(options.dimensions.match)
			: `${options.dimensions.match}x${options.dimensions.answer}`;

	if (kind === "memory") {
		return {
			store: createMemoryCacheStore({ now: options.now }),
			kind,
			note: "内存 —— 进程退出即丢。设 SEMCACHE_DB 换 pgvector，设 SEMCACHE_REDIS 换 Redis。",
			async close() {},
		};
	}

	// 连接串里带密码，不能整条打出来
	const mask = (url: string): string => url.replace(/\/\/[^@]*@/u, "//***@");

	if (kind === "redis") {
		if (!redisUrl) throw new Error("STORE=redis 需要同时给 SEMCACHE_REDIS（如 redis://localhost:6379/2）");
		const namespace = process.env.SEMCACHE_NS ?? `semcache_${dims}`;
		const client = await loadRedisClient(redisUrl);
		const store = createRedisVectorSetCacheStore({
			redis: client,
			namespace,
			dimensions: options.dimensions,
			now: options.now,
			ann,
		});
		await store.ensureSchema();
		return {
			store,
			kind,
			note:
				`vectorset ${mask(redisUrl)} 前缀 ${namespace}（match ${options.dimensions.match} 维，` +
				`${ann ? "HNSW 近似" : "scope 内精确 KNN"}）`,
			async close() {
				await client.close();
			},
		};
	}

	if (!pgUrl) throw new Error("STORE=pgvector 需要同时给 SEMCACHE_DB（如 postgres://postgres:postgres@localhost:5432/semcache）");

	const table = process.env.SEMCACHE_TABLE ?? `semantic_cache_${dims}`;
	const pool = loadPgPool(pgUrl);
	const store = createPgVectorCacheStore({
		sql: pool,
		table,
		dimensions: options.dimensions,
		now: options.now,
		ann,
	});
	await store.ensureSchema();

	return {
		store,
		kind,
		note: `pgvector ${mask(pgUrl)} 表 ${table}（match ${options.dimensions.match} 维 / answer ${options.dimensions.answer} 维${ann ? "，HNSW" : "，scope 内精确 KNN"}）`,
		async close() {
			await pool.end();
		},
	};
}
