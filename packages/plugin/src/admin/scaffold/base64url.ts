/**
 * Base64url codec for the scaffold's opaque control tokens (the drill
 * {@link ../nav.js NavPath}/keyset cursor and the {@link ../carrier.js carrier}).
 *
 * Extracted so the two token modules share ONE encoding: a nav token and a
 * carrier token both end up in operator-visible places (a button payload, a
 * form's `block_id`) and both must survive JSON, a URL and a React key without
 * `+`, `/` or `=`.
 *
 * IO-FREE: `btoa`/`atob` are workerd/Node globals, not egress. (Deliberately
 * NOT naming the guard's other forbidden token here — `sandbox-clean-guard.ts`
 * greps source text, so even a comment mentioning it is an offender, the same
 * reason `list-detail.ts` avoids spelling out the f-word.)
 */

export function toBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Throws on non-base64 input — every caller decodes inside a try/catch. */
export function fromBase64Url(token: string): Uint8Array {
	const bin = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** JSON → base64url. */
export function encodeJsonToken(value: unknown): string {
	return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** base64url → JSON. Throws on malformed input (callers catch). */
export function decodeJsonToken(token: string): unknown {
	return JSON.parse(new TextDecoder().decode(fromBase64Url(token))) as unknown;
}
