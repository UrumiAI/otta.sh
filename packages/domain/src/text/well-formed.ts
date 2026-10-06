/**
 * Text a document store can actually hold.
 *
 * Every Otta document is stored as `JSON.stringify` text, and on Postgres the host
 * reads it back through `(data)::jsonb` for every `where` and `orderBy`. `jsonb`
 * refuses exactly two things a JavaScript string can carry:
 *
 * - a LONE UTF-16 surrogate (a high surrogate not followed by a low one, or a low
 *   one not preceded by a high one) — `JSON.stringify` writes it as a `"\ud800"`
 *   escape, and `jsonb` answers `invalid input syntax for type json`;
 * - U+0000 — written as `"\u0000"`, answered `unsupported Unicode escape sequence`.
 *
 * Because the cast runs over every row in scope, one such string in one document
 * used to make a whole collection unqueryable (security review R3-B, X1). Nothing
 * else is refused: other controls, noncharacters and proper surrogate pairs are
 * all valid JSON text, and refusing them would refuse real input for nothing.
 *
 * Pure, no IO. The plugin's boundary REFUSES such input (see `commerce-input.ts`);
 * the storage adapter REPAIRS anything that reaches it with {@link toWellFormedText}.
 */

/** A lone surrogate (either half) or U+0000. Code-unit regex — no `u` flag, on
 *  purpose: with `u`, a lone surrogate is not something the pattern can see. */
// oxlint-disable-next-line no-control-regex -- U+0000 is one of the two things this rule exists to find
const ILL_FORMED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/;
// oxlint-disable-next-line no-control-regex -- as above
const ILL_FORMED_GLOBAL = new RegExp(ILL_FORMED.source, "g");

/** True when `value` holds no lone surrogate and no U+0000 — storable as-is. */
export function isWellFormedText(value: string): boolean {
	return !ILL_FORMED.test(value);
}

/**
 * Replace every lone surrogate and every U+0000 with U+FFFD, one for one (the
 * length never changes). `String.prototype.toWellFormed` does the surrogate half
 * of this; NUL is the half it does not.
 */
export function toWellFormedText(value: string): string {
	return isWellFormedText(value) ? value : value.replace(ILL_FORMED_GLOBAL, "\uFFFD");
}

/** A path segment for {@link findIllFormedText}'s answer: `a.b[2]`. */
function join(path: string, segment: string | number): string {
	if (typeof segment === "number") return `${path}[${String(segment)}]`;
	return path === "" ? segment : `${path}.${segment}`;
}

/**
 * The path of the first string — value or object KEY — in a JSON-shaped value
 * that is not well formed, or `null` when there is none. A key is reported as
 * `(key "…")`, JSON-escaped, so the answer is itself printable. The root
 * string itself is the empty path.
 */
export function findIllFormedText(value: unknown, path = ""): string | null {
	if (typeof value === "string") return isWellFormedText(value) ? null : path;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const found = findIllFormedText(value[i], join(path, i));
			if (found !== null) return found;
		}
		return null;
	}
	if (typeof value === "object" && value !== null) {
		for (const [key, child] of Object.entries(value)) {
			if (!isWellFormedText(key)) {
				// `JSON.stringify` escapes both offenders, so the answer stays printable.
				return join(path, `(key ${JSON.stringify(key)})`);
			}
			const found = findIllFormedText(child, join(path, key));
			if (found !== null) return found;
		}
	}
	return null;
}

/**
 * `value` with every string — value or key — passed through
 * {@link toWellFormedText}. Returns the SAME reference when nothing needed it, so
 * the common case costs one walk and no copy; otherwise copies only the branches
 * that changed and never mutates the input.
 */
export function repairIllFormedText<T>(value: T): T {
	return repair(value) as T;
}

function repair(value: unknown): unknown {
	if (typeof value === "string") return toWellFormedText(value);
	if (Array.isArray(value)) {
		let out: unknown[] | undefined;
		for (let i = 0; i < value.length; i++) {
			const next = repair(value[i]);
			if (next !== value[i]) {
				out ??= value.slice();
				out[i] = next;
			}
		}
		return out ?? value;
	}
	if (typeof value === "object" && value !== null) {
		let changed = false;
		const entries = Object.entries(value).map(([key, child]): [string, unknown] => {
			const nextKey = toWellFormedText(key);
			const next = repair(child);
			if (nextKey !== key || next !== child) changed = true;
			return [nextKey, next];
		});
		return changed ? Object.fromEntries(entries) : value;
	}
	return value;
}
