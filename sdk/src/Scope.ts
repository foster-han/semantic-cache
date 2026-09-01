/**
 * 隔离边界的组合与校验。
 *
 * **为什么组织 id 必须由库来拼,而不是让调用方自己拼一个字符串。**
 *
 * ③ 是 scope **内**的向量召回 —— 把问题文本从 key 里拿掉之后,剩下用来分桶的
 * 就只有这个字符串了。它拼错的后果不是「少一次命中」,是**跨租户返回别人的答案**,
 * 而且完全静默:向量照样算得出来,相似度照样很高,trace 上一切正常。
 *
 * 自己拼字符串有两类错法,都不会报错:
 *
 * - **漏了租户**。`course:ml101` 看着挺具体,但两个组织都可以有一门 `ml101`。
 * - **分隔符撞了**。`${org}:${key}` 这种拼法下,`("a", "b:c")` 和 `("a:b", "c")`
 *   拼出来是同一个字符串 —— 一个组织 id 里带冒号就能读到另一个组织的桶。
 *
 * 所以 `ScopeDecision.org` 是必填的,而且由 `composeScope` 转义后拼接。
 */

/** 组合后的 scope 里,这个字符分隔两段;段内出现时转义 */
const SEPARATOR = "|";

function escape(part: string): string {
	return part.replaceAll("\\", "\\\\").replaceAll(SEPARATOR, `\\${SEPARATOR}`);
}

function assertPart(name: string, value: string): void {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(
			`ScopeDecision.${name} 是空的。${name === "org" ? "组织 id" : "scope key"}缺失时,③ 的向量召回会在一个错误的桶里进行 —— ` +
				"结果是跨租户返回别人的答案,而且不会报错。单租户部署也要给一个固定值(比如 \"default\"),让它是个显式的决定。",
		);
	}
}

/**
 * 把组织 id 与业务 scope 拼成存储层看到的那一个字符串。
 *
 * 转义保证一一对应:`("a", "b|c")` 与 `("a|b", "c")` 拼出来不同。
 * `clear(scope)` 之类按 scope 操作的入口要的就是这个组合后的值。
 */
export function composeScope(org: string, key: string): string {
	assertPart("org", org);
	assertPart("key", key);
	return `${escape(org)}${SEPARATOR}${escape(key)}`;
}
