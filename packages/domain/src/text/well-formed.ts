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

/**
 * A key that prints as itself in a path: a camelCase field name, which is the
 * document's schema. Anything else — a sku, an idempotency key, an email, an
 * ill-formed key — may be a shopper's text, and a path goes to a log, so it is
 * named by its position instead: `(key #n)`.
 */
const FIELD_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;

/**
 * The document fields whose value is a MAP keyed by data — a sku, an idempotency
 * key, a variant key, a reservation or rate id — rather than by schema (the
 * `Record<string, …>` fields of the stored documents). A key there can look like a
 * field name (`beans250g`, a hex idempotency key) and still be a shopper's text,
 * so every entry of such a map prints by position (review B L6).
 */
const MAP_FIELDS: ReadonlySet<string> = new Set([
	"holds",
	"lines",
	"methods",
	"mutations",
	"pendingRenames",
	"rates",
	"refundRetries",
	"stateCounts",
	"variants",
]);

/**
 * Whether an object's keys print by position: it is the value of a known map
 * field, or any of its well-formed keys is not a field name (so it is a map keyed
 * by data, and its field-name-shaped keys may be data too). An ill-formed key
 * always prints by position, and on its own says nothing about its siblings.
 */
function keysArePositional(parentKey: string | undefined, keys: readonly string[]): boolean {
	if (parentKey !== undefined && MAP_FIELDS.has(parentKey)) return true;
	return keys.some((key) => isWellFormedText(key) && !FIELD_NAME.test(key));
}

/** A path segment for {@link findIllFormedText}'s answer: `a.b[2]`, `m.(key #1)`. */
function join(path: string, segment: string | number): string {
	if (typeof segment === "number") return `${path}[${String(segment)}]`;
	return path === "" ? segment : `${path}.${segment}`;
}

function keySegment(key: string, position: number, positional: boolean): string {
	return positional || !FIELD_NAME.test(key) ? `(key #${String(position)})` : key;
}

/**
 * The path of the first string — value or object KEY — in a JSON-shaped value
 * that is not well formed, or `null` when there is none. The root string itself
 * is the empty path. The answer is safe to log: a key that is not a plain field
 * name (an ill-formed key included), and every key of a map keyed by data (see
 * `MAP_FIELDS`), is written `(key #n)`, its position in its object, never its
 * text.
 */
export function findIllFormedText(value: unknown, path = ""): string | null {
	return find(value, path, undefined);
}

function find(value: unknown, path: string, parentKey: string | undefined): string | null {
	if (typeof value === "string") return isWellFormedText(value) ? null : path;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const found = find(value[i], join(path, i), undefined);
			if (found !== null) return found;
		}
		return null;
	}
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value);
		const positional = keysArePositional(
			parentKey,
			entries.map(([key]) => key),
		);
		for (let i = 0; i < entries.length; i++) {
			const [key, child] = entries[i] as [string, unknown];
			if (!isWellFormedText(key)) return join(path, `(key #${String(i)})`);
			const found = find(child, join(path, keySegment(key, i, positional)), key);
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
 *
 * KEYS NEVER MERGE SILENTLY. Two keys that differ only in their ill-formed code
 * units (`"k\uD800"`, `"k\uDC00"`) repair to the same text. Exactly one entry is
 * kept, deterministically: the key that was ALREADY well formed if there is one
 * (it is the genuine record; the other is the one that slipped past a boundary),
 * else the first in the object's order. Every other entry is dropped, and its
 * path — in {@link findIllFormedText}'s log-safe form — is passed to
 * `onDroppedKey`, so the caller can say so. Dropping rather than throwing is on
 * purpose: this also heals legacy documents, and a heal that throws leaves the
 * row unreadable for good.
 */
export function repairIllFormedText<T>(value: T, onDroppedKey?: (path: string) => void): T {
	return repair(value, "", undefined, onDroppedKey) as T;
}

function repair(
	value: unknown,
	path: string,
	parentKey: string | undefined,
	onDroppedKey: ((path: string) => void) | undefined,
): unknown {
	if (typeof value === "string") return toWellFormedText(value);
	if (Array.isArray(value)) {
		let out: unknown[] | undefined;
		for (let i = 0; i < value.length; i++) {
			const next = repair(value[i], join(path, i), undefined, onDroppedKey);
			if (next !== value[i]) {
				out ??= value.slice();
				out[i] = next;
			}
		}
		return out ?? value;
	}
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value);
		const positional = keysArePositional(
			parentKey,
			entries.map(([key]) => key),
		);
		const repairedKeys = entries.map(([key]) => toWellFormedText(key));
		// Which original entry each repaired key keeps: an already-well-formed key
		// (only one can exist per repaired key — object keys are unique), else the first.
		const keeper = new Map<string, number>();
		for (let i = 0; i < entries.length; i++) {
			const nextKey = repairedKeys[i] as string;
			const held = keeper.get(nextKey);
			const wellFormed = repairedKeys[i] === (entries[i] as [string, unknown])[0];
			if (held === undefined || wellFormed) keeper.set(nextKey, i);
		}
		let changed = false;
		const out: [string, unknown][] = [];
		for (let i = 0; i < entries.length; i++) {
			const [key, child] = entries[i] as [string, unknown];
			const nextKey = repairedKeys[i] as string;
			if (keeper.get(nextKey) !== i) {
				changed = true;
				onDroppedKey?.(join(path, `(key #${String(i)})`));
				continue;
			}
			const next = repair(child, join(path, keySegment(key, i, positional)), key, onDroppedKey);
			if (nextKey !== key || next !== child) changed = true;
			out.push([nextKey, next]);
		}
		return changed ? Object.fromEntries(out) : value;
	}
	return value;
}
