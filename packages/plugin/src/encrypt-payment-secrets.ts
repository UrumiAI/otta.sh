/**
 * Re-save the payment credentials an earlier build stored, ONCE, so they are
 * encrypted at rest (ADR-0032).
 *
 * Declaring a field `type: "secret"` makes EmDash encrypt every NEW write to it,
 * and its read path still accepts a value stored before the declaration. So a
 * value saved by an earlier build keeps working, but stays as it was stored
 * until it is written again. This writes each one again, through the same
 * `ctx.kv` path the Settings form uses, and therefore through EmDash's
 * encryption.
 *
 * PER KEY, IN THIS ORDER, AND WHY IT CANNOT LOSE A KEY:
 *  1. `getVersioned` — the current value (decrypted, if it already was
 *     encrypted) and its revision.
 *  2. `compareAndSet` at that revision — one statement that REPLACES the
 *     stored row with the encrypted envelope of the SAME value. There is no
 *     moment with no value: the row holds either the old form or the new one.
 *     Writing at the read revision means a key an operator saved in between
 *     is never overwritten with the older one; the conflict is retried on a
 *     later tick instead.
 *     With no encryption key the host refuses BEFORE writing, so nothing
 *     changes.
 *  3. Read back and compare. Only when every key read back equal is the marker
 *     written; until then, every later tick tries again. Re-saving a value that
 *     is already encrypted is harmless (a fresh envelope of the same value),
 *     which is what makes a retry after an interruption safe.
 *
 * There is no separate plain-text row to delete afterwards: step 2 overwrites
 * it in place. (EmDash's sandboxed bridge also deletes its own pre-1.0 copy of
 * the key on that write.)
 *
 * It never throws and never logs a value or an error message — only a fixed
 * line naming what to fix. A site without the `secret` declaration is not
 * detectable from here (the kv read path is the same either way); the site
 * descriptor's test pins the declaration instead.
 *
 * COST: one kv read per site per isolate once done; four reads, four
 * conditional writes, four read-backs and one marker write, once.
 */
import { ENCRYPTED_PAYMENT_SECRET_KEYS } from "./payment-secrets.js";
import type { PluginContext } from "./types.js";

/** Set once every stored payment credential has been re-saved encrypted. The
 *  value names the key set, so a future addition to the set runs again. */
export const PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY = "state:paymentSecretsEncrypted";

/** The marker's value for the current key set. */
export const PAYMENT_SECRETS_ENCRYPTED_MARKER_VALUE = `v1:${ENCRYPTED_PAYMENT_SECRET_KEYS.join(",")}`;

/** What one call did. */
export type EncryptPaymentSecretsOutcome =
	/** Every stored credential was re-saved and read back; the marker is set. */
	| "encrypted"
	/** The marker was already set (or this isolate already saw it). */
	| "already-done"
	/** Something stopped it part way; nothing was lost, and a later call retries. */
	| "retry";

/** Sites this isolate has seen finished, by site URL ("" when the host gives
 *  none) — per site, in case an isolate ever serves more than one. */
const doneInIsolate = new Set<string>();

/** Failures already reported by this isolate, so a tick every minute does not
 *  repeat the same line every minute. */
const reportedInIsolate = new Set<string>();

/** TESTS ONLY: forget what this isolate has seen. */
export function resetPaymentSecretEncryptionForTesting(): void {
	doneInIsolate.clear();
	reportedInIsolate.clear();
}

/** EmDash's `PluginSettingEncryptionError` codes that mean "the encryption key
 *  is missing or is not the one these values were saved with". Matched by
 *  `code` only; the error's message is never read. */
const KEY_PROBLEM_CODES: ReadonlySet<string> = new Set([
	"PLUGIN_SETTING_ENCRYPTION_KEY_MISSING",
	"PLUGIN_SETTING_ENCRYPTION_KEY_UNKNOWN",
	"PLUGIN_SETTING_DECRYPTION_FAILED",
	"PLUGIN_SETTING_ENCRYPTION_KEY_INVALID",
	"INVALID_ENCRYPTION_KEY",
]);

function isKeyProblem(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	const code = (error as { code: unknown }).code;
	return typeof code === "string" && KEY_PROBLEM_CODES.has(code);
}

/** Log a FIXED line once per isolate per kind. Never a value, never an error. */
function reportOnce(kind: "key" | "host" | "other"): void {
	if (reportedInIsolate.has(kind)) return;
	reportedInIsolate.add(kind);
	const line =
		kind === "key"
			? "[otta] payment keys are not encrypted yet: EMDASH_ENCRYPTION_KEY is missing or is not the key they were saved with; will retry"
			: kind === "host"
				? "[otta] payment keys are not encrypted yet: this host's kv has no conditional write; will retry"
				: "[otta] payment keys are not encrypted yet; will retry";
	console.warn(line);
}

/**
 * Re-save every stored payment credential through the encrypted path unless
 * that already happened for this site. Never throws.
 */
export async function encryptStoredPaymentSecrets(
	ctx: PluginContext,
): Promise<EncryptPaymentSecretsOutcome> {
	const site = ctx.site?.url ?? "";
	if (doneInIsolate.has(site)) return "already-done";
	const { kv } = ctx;
	try {
		if (
			(await kv.get<unknown>(PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY)) ===
			PAYMENT_SECRETS_ENCRYPTED_MARKER_VALUE
		) {
			doneInIsolate.add(site);
			return "already-done";
		}
		// Without the conditional pair a re-save could overwrite a key an operator
		// saves at the same moment. Leave everything as it is instead.
		if (kv.getVersioned === undefined || kv.compareAndSet === undefined) {
			reportOnce("host");
			return "retry";
		}
		for (const key of ENCRYPTED_PAYMENT_SECRET_KEYS) {
			const current = await kv.getVersioned<unknown>(key);
			if (current === null) continue;
			const written = await kv.compareAndSet(key, current.revision, current.value);
			if (!written.applied) {
				// Someone wrote this key since the read — through the same encrypted
				// path. Re-check on a later tick rather than guess.
				return "retry";
			}
			if ((await kv.get<unknown>(key)) !== current.value) {
				reportOnce("other");
				return "retry";
			}
		}
		await kv.set(PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY, PAYMENT_SECRETS_ENCRYPTED_MARKER_VALUE);
		doneInIsolate.add(site);
		return "encrypted";
	} catch (error) {
		reportOnce(isKeyProblem(error) ? "key" : "other");
		return "retry";
	}
}
