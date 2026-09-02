/**
 * Composition and validation of the isolation boundary.
 *
 * **Why the organization id must be joined by the library rather than by the caller.**
 *
 * Gate ③ is vector recall **within** a scope — once the question text is out of the key, this
 * string is all that buckets entries. Getting it wrong does not cost a hit, it **returns another
 * tenant's answer**, completely silently: the vectors still compute, the similarity is still high,
 * and the trace looks entirely normal.
 *
 * Hand-built strings fail in two ways, neither of which raises an error:
 *
 * - **The tenant is missing.** `course:ml101` looks specific enough, but two organizations can both
 *   have an `ml101`.
 * - **The separator collides.** Under a `${org}:${key}` join, `("a", "b:c")` and `("a:b", "c")`
 *   produce the same string — one organization id containing a colon is enough to read another
 *   organization's bucket.
 *
 * So `ScopeDecision.org` is required, and `composeScope` joins it with escaping.
 */

/** Separates the two segments inside a composed scope; escaped when it occurs within a segment. */
const SEPARATOR = "|";

function escapePart(part: string): string {
	return part.replaceAll("\\", "\\\\").replaceAll(SEPARATOR, `\\${SEPARATOR}`);
}

function assertPart(name: string, value: string): void {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(
			`ScopeDecision.${name} is empty. Without the ${name === "org" ? "organization id" : "scope key"}, gate ③'s vector recall runs in the wrong bucket — ` +
				'the result is returning another tenant\'s answer, and nothing raises an error. Single-tenant deployments must still supply a fixed value (for example "default"), so that it is an explicit decision.',
		);
	}
}

/**
 * Joins the organization id and the business scope into the single string the storage layer sees.
 *
 * Escaping guarantees a one-to-one mapping: `("a", "b|c")` and `("a|b", "c")` produce different
 * strings. Scope-wide entry points such as `clear(scope)` expect this composed value.
 */
export function composeScope(org: string, key: string): string {
	assertPart("org", org);
	assertPart("key", key);
	return `${escapePart(org)}${SEPARATOR}${escapePart(key)}`;
}
