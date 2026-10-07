/**
 * The one-way function between a bearer token and what is stored for it.
 *
 * Two documents are keyed on the output and never on the input: a session's
 * document id is the hash of its token, and a challenge carries the hash of the
 * token that was emailed. So a database read — a dump, a log of a query, an admin
 * surface, a backup — yields nothing that can be presented as a credential.
 *
 * **SHA-256, unsalted, and that is deliberate.** The input is not a password: it
 * is a high-entropy opaque identifier this package minted (`id-gen.ts`), so there
 * is no dictionary to precompute and nothing for a salt or a work factor to buy.
 * The SQL adapter made the same choice with `node:crypto`'s `createHash("sha256")`,
 * and the wire format here is identical — lowercase hex — so the two adapters agree
 * on what a stored hash looks like.
 *
 * **WebCrypto off `globalThis`, never `node:crypto`.** This module is bundled into
 * the workerd sandbox, where a `node:` import is a runtime failure the type system
 * would not have caught, and where `timingSafeEqual` does not exist. Hence the
 * async digest and the hand-written constant-time comparison below.
 */

const encoder = new TextEncoder();

/** Lowercase hex of the SHA-256 of `token`. The stored form, in both adapters. */
export async function hashToken(token: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(token));
	let hex = "";
	for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

/**
 * Compare two hashes without leaking, through timing, how far they agreed.
 *
 * It replaces `node:crypto`'s `timingSafeEqual`, which the sandbox does not have.
 * The loop runs over the full length with no early exit and accumulates the
 * difference, so the work done does not depend on where the first mismatch is. A
 * length mismatch is answered immediately — the lengths are not secret (every
 * SHA-256 hex string is 64 characters), and a comparison of unequal lengths has no
 * secret-dependent path to protect.
 *
 * It is used where a caller-supplied token is checked against a stored hash. The
 * session path does not need it — there the hash IS the document id, so the
 * lookup either finds a document or does not — and the challenge path does, because
 * the challenge is found by its own id first and the token is then compared.
 */
export function tokenHashEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return difference === 0;
}
