import type { ActionsBlock, SelectFieldSpec } from "../../types.js";

/**
 * Navigation primitives for the admin list/detail scaffold.
 *
 * A screen is an ordered stack of LEVELS; the location within it is a
 * {@link NavPath} — the selected ids from the root list down to the current
 * level. `[]` renders the root list; `["ord-1"]` the detail (or first
 * sub-list) of `ord-1`; `["z1","m2"]` the third-level list under zone `z1`,
 * method `m2`. Drilling in appends an id; "back" pops the last one. This is
 * deliberately N-level: the orders console only ever reaches depth 2 (list →
 * detail), but zones → methods → rates is the same primitive at depth 3.
 *
 * Two things must survive a STATELESS Block interaction, so both are encoded
 * into the control payloads the scaffold renders:
 *   - the {@link NavPath} — carried in a `back` button's `value.__path` and in
 *     the keyset cursor token (so "Load more" re-renders the same level), and
 *   - the list filter + opaque service cursor — carried in the same token.
 *
 * IO-FREE: pure serialization. No `ctx`, no `fetch` — keeps the sandbox-clean
 * guard green (this module never appears among the network-egress offenders).
 */

/** The drill path: selected ids from the root list to the current level. */
export type NavPath = readonly string[];

/** The reserved payload key a nav control carries its encoded {@link NavPath}
 *  in (a `block_action`'s `value` object, or a `form_submit`'s `values`). */
export const PATH_FIELD = "__path";

/** The keyset cursor token wrapping the SERVICE cursor + the list's own form +
 *  the level's drill path, so a paged re-render restores all three. */
export interface ListCursor<F = unknown> {
	/** The opaque SERVICE cursor for the next page. */
	c: string;
	/** The list's filter form, re-populated on the paged re-render. */
	f: F;
	/** The drill path of THIS list level (ancestor ids); omitted at the root. */
	p?: NavPath;
}

export function encodePath(path: NavPath): string {
	return toBase64Url(new TextEncoder().encode(JSON.stringify(path)));
}

export function decodePath(token: string): NavPath | null {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(token))) as unknown;
		if (!Array.isArray(parsed)) return null;
		if (!parsed.every((x): x is string => typeof x === "string")) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function encodeListCursor<F>(cursor: ListCursor<F>): string {
	return toBase64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}

export function decodeListCursor<F = unknown>(token: string): ListCursor<F> | null {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(token))) as unknown;
		if (parsed === null || typeof parsed !== "object") return null;
		const p = parsed as { c?: unknown; f?: unknown; p?: unknown };
		if (typeof p.c !== "string") return null;
		const f = (p.f !== null && typeof p.f === "object" ? p.f : {}) as F;
		const path = Array.isArray(p.p) && p.p.every((x) => typeof x === "string") ? p.p : undefined;
		return path === undefined ? { c: p.c, f } : { c: p.c, f, p: path };
	} catch {
		return null;
	}
}

/** A consistent "← Back" control. When `path` is a non-empty drill location the
 *  current path rides along in the button `value` so the scaffold's `back`
 *  handler can pop exactly one level (needed at depth ≥ 3); at depth ≤ 2 the
 *  handler falls back to the root list, so callers may omit it for a payload
 *  byte-identical to a value-less back button. */
export function backButton(actionId: string, label: string, path?: NavPath): ActionsBlock {
	const carry = path !== undefined && path.length > 0;
	return {
		type: "actions",
		elements: [
			{
				type: "button",
				action_id: actionId,
				label,
				...(carry ? { value: { [PATH_FIELD]: encodePath(path) } } : {}),
			},
		],
	};
}

/**
 * The filter form's drill-path carrier: a single-option `select` whose value is
 * the encoded {@link NavPath}, so a stateless `apply-filter` `form_submit` at
 * depth ≥ 1 re-lists the CURRENT level (not the root). Same
 * carry-the-id-in-values pattern as the orders open-order form.
 *
 * Screens normally never need to call this — the scaffold engine AUTO-INJECTS
 * this field into every rendered form whose submit fires `applyFilter` at
 * depth ≥ 1 (see `createListDetailHandler`), so the carry cannot be silently
 * omitted. It is exported for screens that want to control field placement.
 */
export function filterPathField(path: NavPath): SelectFieldSpec {
	const encoded = encodePath(path);
	return {
		type: "select",
		action_id: PATH_FIELD,
		label: "Scope",
		options: [{ value: encoded, label: "This level" }],
		initial_value: encoded,
	};
}

function toBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(token: string): Uint8Array {
	const bin = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
