/**
 * Issue #497 — can this site store an encrypted payment secret? (ADR-0037)
 *
 * EmDash encrypts a declared-secret `ctx.kv` write under `EMDASH_ENCRYPTION_KEY`,
 * which it reads from `process.env` AT WRITE TIME, and refuses the write when the
 * key is missing or malformed. The Settings screen asks the same question BEFORE
 * the operator types a key, so it can say up front that a save would be refused.
 *
 * ONLY ON A TRUSTED HOST. In-process (`createOttaPlugin({ trustedHost: true })`)
 * the plugin shares the host's isolate, so its `process.env` is the one EmDash's
 * write reads. Under the sandbox runner it is not: an empty `process.env` there
 * says nothing about the host, so the answer is `"unknown"` and no warning shows
 * (the refused save still explains itself).
 *
 * PRESENCE AND SHAPE ONLY. The value is never returned, logged or decoded:
 * EmDash's entry pattern (`emdash_enc_v1_` + 43 base64url chars), plus its
 * canonical-encoding rule — 43 chars carry 258 bits for a 32-byte key, so the
 * last char's two spare bits must be zero.
 */
import { isTrustedHost } from "./payments/trusted-host.js";

export type EncryptionKeyStatus = "present" | "missing" | "malformed" | "unknown";

const ENCRYPTION_KEY_ENTRY = /^emdash_enc_v1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function encryptionKeyStatus(): EncryptionKeyStatus {
	if (!isTrustedHost()) return "unknown";
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env;
	if (env === undefined) return "unknown";
	// A comma-separated list is a rotation (first encrypts); empty entries are
	// ignored, as EmDash ignores them.
	const entries = (env.EMDASH_ENCRYPTION_KEY ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (entries.length === 0) return "missing";
	return entries.every((entry) => ENCRYPTION_KEY_ENTRY.test(entry)) ? "present" : "malformed";
}
