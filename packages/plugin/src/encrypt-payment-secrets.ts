/**
 * Re-save the payment credentials so they are encrypted at rest (ADR-0037):
 * every stored one once, and again whenever one is written by something other
 * than this migration since.
 *
 * Declaring a field `type: "secret"` makes EmDash encrypt every NEW write to it,
 * and its read path still accepts a value stored before the declaration. So a
 * value saved by an earlier build keeps working, but stays as it was stored
 * until it is written again. This writes each one again, through the same
 * `ctx.kv` path the Settings form uses, and therefore through EmDash's
 * encryption.
 *
 * THE MARKER RECORDS REVISIONS (#478). `state:paymentSecretsEncrypted` holds the
 * host revision this migration wrote for each stored key. Each new isolate reads
 * every key's revision and re-saves any key whose revision differs (a value an
 * earlier build re-entered in plain text during a rollback, or one stored for
 * the first time since); a key that matches is not touched. A key saved through
 * the encrypted Settings form also differs, and costs one harmless re-save.
 * What a revision cannot show: a key-ROTATION (the stored row is unchanged) or a
 * site that only later declared the schema. For those, deleting the marker runs
 * every key again (DEPLOYMENT.md).
 *
 * THE STEPS, AND WHY THEY CANNOT LOSE A KEY:
 *  1. PREFLIGHT. Read every target key (`getVersioned`) BEFORE writing any. If a
 *     read fails — above all, a stored ciphertext the configured key cannot
 *     decrypt — stop with nothing written. Otherwise a wrong key would re-save
 *     the still-plain keys under itself, and restoring the right key would then
 *     strand them. (If EVERY key is still plain, a wrong key cannot be told
 *     apart from the right one: whichever key is configured at that tick is the
 *     key they are saved under.)
 *  2. Per key whose revision differs from the marker's, `compareAndSet` at the
 *     preflight revision with the SAME (decrypted) value: one statement that
 *     replaces the stored row with a fresh envelope. The row always holds the
 *     old form or the new one, and either decrypts, so a reader (the webhook
 *     route among them) never sees a gap. A key an operator saved since the
 *     preflight is never overwritten; that is retried on a later tick.
 *     With no encryption key, the host refuses BEFORE writing.
 *     In EmDash's sandboxed bridge a pre-1.0 copy can live outside the options
 *     table; its conditional write then never applies although nothing changed.
 *     When a re-read shows the same revision, the options row is created with a
 *     conditional write that applies only while it is still absent, which the
 *     bridge stores encrypted and which deletes that legacy copy (counted in the log line, never shown).
 *  3. Read back: the same value at the revision this write returned (anything
 *     else is a concurrent save, kept, and retried). Then record that revision
 *     in the marker, so an unfinished run does not re-save the keys it already did.
 *  4. Write the marker once more without the keys no longer stored.
 *
 * NO x402 KEY. x402 is gone; its stored keys (the facilitator API key and the
 * older facilitator secret among them) are deleted by their own one-shot purge
 * (`payments/purge-legacy-x402-settings.ts`), not re-saved here. This touches
 * only {@link ENCRYPTED_PAYMENT_SECRET_KEYS}, so it neither reads nor writes an
 * x402 key, whether or not one is still stored.
 *
 * It never throws and never logs a value or an error message — only fixed lines
 * and counts. A site without the `secret` declaration is not detectable from
 * here (the kv read path is the same either way); the site descriptor's test
 * pins the declaration instead.
 *
 * NOT REACHABLE FROM HERE: in TRUSTED mode, EmDash's kv never touches the
 * sandbox's pre-1.0 storage, so a copy left there by an earlier SANDBOXED
 * deployment of the same database is not visible to the plugin at all.
 */
import { ENCRYPTED_PAYMENT_SECRET_KEYS } from "./payment-secrets.js";
import type { PluginContext } from "./types.js";

/** `{ set, revisions }`: the key-set tag below, and per stored key the revision
 *  this migration wrote. Any other value (an earlier build's `v1:` string among
 *  them) re-saves every key once. */
export const PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY = "state:paymentSecretsEncrypted";

/** The marker's key-set tag. It names the key set, so a future addition to the
 *  set runs again. */
export const PAYMENT_SECRETS_ENCRYPTED_MARKER_VALUE = `v2:${ENCRYPTED_PAYMENT_SECRET_KEYS.join(",")}`;

/** An earlier build's (v1) per-key progress record. No longer written; deleted
 *  when a run completes. */
export const PAYMENT_SECRETS_ENCRYPTION_PROGRESS_KEY = "state:paymentSecretsEncryptionProgress";

/** What one call did. */
export type EncryptPaymentSecretsOutcome =
	/** Every key the marker did not match was re-saved and read back (or was
	 *  gone), and the marker now matches. */
	| "encrypted"
	/** The marker matched every key (or this isolate already saw it match). */
	| "already-done"
	/** Something stopped it; nothing was lost, and a later call retries. */
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
 *  is missing or is not the one these values were saved with". A malformed
 *  stored value (for example a non-string row) raises the same decryption code,
 *  so the "key" log line covers that case too. Matched by `code` only; the
 *  error's message is never read. */
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

type Report = "key" | "keyAfterMarker" | "host" | "conflict" | "other";

const REPORT_LINES: Readonly<Record<Report, string>> = {
	key: "[otta] payment keys are not encrypted yet: EMDASH_ENCRYPTION_KEY is missing, is not the key they were saved with, or a stored value is malformed; nothing was changed; will retry",
	keyAfterMarker:
		"[otta] a stored payment key cannot be read: EMDASH_ENCRYPTION_KEY is missing, is not the key it was saved with, or the stored value is malformed; nothing was changed",
	host: "[otta] payment keys are not encrypted yet: this host's kv has no conditional write; will retry",
	conflict:
		"[otta] payment keys are not encrypted yet: a key changed while they were being re-saved; will retry",
	other: "[otta] payment keys are not encrypted yet; will retry",
};

/** Log a FIXED line once per isolate per kind. Never a value, never an error. */
function reportOnce(kind: Report): void {
	if (reportedInIsolate.has(kind)) return;
	reportedInIsolate.add(kind);
	console.warn(REPORT_LINES[kind]);
}

/** The revisions a marker records, or `null` for no marker, another key set,
 *  or a shape this build does not write (each re-saves every key once). */
function readMarker(value: unknown): Record<string, string> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const { set, revisions } = value as { set?: unknown; revisions?: unknown };
	if (set !== PAYMENT_SECRETS_ENCRYPTED_MARKER_VALUE) return null;
	if (typeof revisions !== "object" || revisions === null || Array.isArray(revisions)) return null;
	const out: Record<string, string> = {};
	for (const [key, revision] of Object.entries(revisions)) {
		if (typeof revision === "string") out[key] = revision;
	}
	return out;
}

/**
 * Re-save every stored payment credential the marker does not match through
 * the encrypted path. Never throws.
 */
export async function encryptStoredPaymentSecrets(
	ctx: PluginContext,
): Promise<EncryptPaymentSecretsOutcome> {
	const site = ctx.site?.url ?? "";
	if (doneInIsolate.has(site)) return "already-done";
	const { kv } = ctx;
	const { getVersioned, compareAndSet } = kv;
	try {
		// Without the conditional pair a re-save could overwrite a key an operator
		// saves at the same moment, and no revision can be compared. Leave
		// everything as it is instead.
		if (getVersioned === undefined || compareAndSet === undefined) {
			reportOnce("host");
			return "retry";
		}
		const getV = getVersioned.bind(kv);
		const cas = compareAndSet.bind(kv);

		// 1. PREFLIGHT — every read first; any failure writes nothing.
		const stored: Array<{ key: string; value: unknown; revision: string }> = [];
		try {
			for (const key of ENCRYPTED_PAYMENT_SECRET_KEYS) {
				const current = await getV<unknown>(key);
				if (current !== null) stored.push({ key, ...current });
			}
		} catch (error) {
			if (!isKeyProblem(error)) {
				reportOnce("other");
				return "retry";
			}
			// A key problem on a site the marker says was encrypted: nothing here
			// can be re-saved until the key is fixed and a new isolate starts.
			// Say so once and stop checking in this isolate, instead of failing the
			// same preflight every tick.
			if (readMarker(await kv.get<unknown>(PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY)) !== null) {
				reportOnce("keyAfterMarker");
				doneInIsolate.add(site);
				return "retry";
			}
			reportOnce("key");
			return "retry";
		}

		const recorded = readMarker(await kv.get<unknown>(PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY));
		const pending = stored.filter(({ key, revision }) => recorded?.[key] !== revision);
		if (
			recorded !== null &&
			pending.length === 0 &&
			Object.keys(recorded).length === stored.length
		) {
			doneInIsolate.add(site);
			return "already-done";
		}

		// The keys that already match stay recorded; a key no longer stored drops out.
		const revisions: Record<string, string> = {};
		for (const { key, revision } of stored) {
			if (recorded?.[key] === revision) revisions[key] = revision;
		}

		// Retry cost: before the first marker, while the key is missing, each sweep
		// tick costs a handful of kv calls (the preflight and marker reads, and when
		// every value is still plain, one refused conditional write), and logs once
		// per isolate. Intentional and bounded. Once a marker exists, a key problem
		// costs one failed preflight and one marker read per ISOLATE (see above).
		let resaved = 0;
		let legacyReplaced = 0;
		for (const { key, value, revision } of pending) {
			// 2. The conditional re-save.
			let written = await cas(key, revision, value);
			if (!written.applied) {
				const again = await getV<unknown>(key);
				if (again === null || again.revision !== revision) {
					reportOnce("conflict");
					return "retry";
				}
				// Same revision, yet the conditional write did not apply: the value
				// lives outside the options table (a sandboxed pre-1.0 copy). Create the
				// options row only if it is STILL absent (expected revision `null`), so
				// an operator's save at this moment is never overwritten; the bridge
				// deletes the pre-1.0 copy when this applies.
				written = await cas(key, null, value);
				if (!written.applied) {
					reportOnce("conflict");
					return "retry";
				}
				legacyReplaced += 1;
			}

			// 3. Read back exactly what this write stored, then record its revision.
			const back = await getV<unknown>(key);
			if (back === null || back.revision !== written.revision || back.value !== value) {
				reportOnce("conflict");
				return "retry";
			}
			revisions[key] = written.revision;
			// Plain `kv.set`, no compare-and-set: two isolates running at once can overwrite each
			// other's entries in `revisions`. Harmless: a dropped entry only makes a later run
			// re-save that key once more (same value, fresh envelope). The marker is never
			// trusted for a key whose current revision it does not match.
			await kv.set(PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY, {
				set: PAYMENT_SECRETS_ENCRYPTED_MARKER_VALUE,
				revisions,
			});
			resaved += 1;
		}

		// 4. Done.
		await kv.set(PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY, {
			set: PAYMENT_SECRETS_ENCRYPTED_MARKER_VALUE,
			revisions,
		});
		await kv.delete(PAYMENT_SECRETS_ENCRYPTION_PROGRESS_KEY);
		doneInIsolate.add(site);
		console.info(
			`[otta] payment keys re-saved through the settings layer: ${String(resaved)} re-saved, ` +
				`${String(legacyReplaced)} legacy copies replaced`,
		);
		return "encrypted";
	} catch (error) {
		reportOnce(isKeyProblem(error) ? "key" : "other");
		return "retry";
	}
}
