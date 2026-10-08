/**
 * Re-save the payment credentials an earlier build stored, ONCE, so they are
 * encrypted at rest (ADR-0032), and remove the retired x402 secret.
 *
 * Declaring a field `type: "secret"` makes EmDash encrypt every NEW write to it,
 * and its read path still accepts a value stored before the declaration. So a
 * value saved by an earlier build keeps working, but stays as it was stored
 * until it is written again. This writes each one again, through the same
 * `ctx.kv` path the Settings form uses, and therefore through EmDash's
 * encryption.
 *
 * THE STEPS, AND WHY THEY CANNOT LOSE A KEY:
 *  1. PREFLIGHT. Read every target key (`getVersioned`) BEFORE writing any. If a
 *     read fails — above all, a stored ciphertext the configured key cannot
 *     decrypt — stop with nothing written. Otherwise a wrong key would re-save
 *     the still-plain keys under itself, and restoring the right key would then
 *     strand them. (If EVERY key is still plain, a wrong key cannot be told
 *     apart from the right one: whichever key is configured at that tick is the
 *     key they are saved under.)
 *  2. Per key, `compareAndSet` at the preflight revision with the SAME value:
 *     one statement that replaces the stored row with its encrypted envelope.
 *     The row always holds the old form or the new one. A key an operator saved
 *     since the preflight is never overwritten; that is retried on a later tick.
 *     With no encryption key, the host refuses BEFORE writing.
 *     In EmDash's sandboxed bridge a pre-1.0 copy can live outside the options
 *     table; its conditional write then never applies although nothing changed.
 *     When a re-read shows the same revision, the key is written with a plain
 *     `set` instead, which the bridge stores encrypted and which deletes that
 *     legacy copy (counted in the log line, never shown).
 *  3. Read back and compare; then record the key's new revision in a progress
 *     record, so an unfinished run does not re-save the keys it already did.
 *  4. Delete `settings:x402FacilitatorSecret`, the retired x402 secret nothing
 *     reads (ADR-0028), counted in the log line.
 *  5. Write the marker. Until then, every later tick resumes.
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
import {
	ENCRYPTED_PAYMENT_SECRET_KEYS,
	X402_LEGACY_FACILITATOR_SECRET_KEY,
} from "./payment-secrets.js";
import type { PluginContext } from "./types.js";

/** Set once every stored payment credential has been re-saved encrypted. The
 *  value names the key set, so a future addition to the set runs again. */
export const PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY = "state:paymentSecretsEncrypted";

/** The marker's value for the current key set. */
export const PAYMENT_SECRETS_ENCRYPTED_MARKER_VALUE = `v1:${ENCRYPTED_PAYMENT_SECRET_KEYS.join(",")}`;

/** Per-key progress of an unfinished run: kv key → the revision this migration
 *  wrote. A key still at that revision is already encrypted and is skipped. */
export const PAYMENT_SECRETS_ENCRYPTION_PROGRESS_KEY = "state:paymentSecretsEncryptionProgress";

/** What one call did. */
export type EncryptPaymentSecretsOutcome =
	/** Every stored credential was re-saved and read back; the marker is set. */
	| "encrypted"
	/** The marker was already set (or this isolate already saw it). */
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

type Report = "key" | "host" | "conflict" | "other";

const REPORT_LINES: Readonly<Record<Report, string>> = {
	key: "[otta] payment keys are not encrypted yet: EMDASH_ENCRYPTION_KEY is missing or is not the key they were saved with; nothing was changed; will retry",
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

function readProgress(value: unknown): Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, revision] of Object.entries(value)) {
		if (typeof revision === "string") out[key] = revision;
	}
	return out;
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
	const { getVersioned, compareAndSet } = kv;
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
			reportOnce(isKeyProblem(error) ? "key" : "other");
			return "retry";
		}

		const progress = readProgress(await kv.get<unknown>(PAYMENT_SECRETS_ENCRYPTION_PROGRESS_KEY));
		let resaved = 0;
		let legacyReplaced = 0;
		for (const { key, value, revision } of stored) {
			// 3 (earlier run). Re-saved by this migration and unchanged since.
			if (progress[key] === revision) continue;

			// 2. The conditional re-save.
			const written = await cas(key, revision, value);
			if (!written.applied) {
				const again = await getV<unknown>(key);
				if (again === null || again.revision !== revision) {
					reportOnce("conflict");
					return "retry";
				}
				// Same revision, yet the conditional write did not apply: the value
				// lives outside the options table (a sandboxed pre-1.0 copy).
				await kv.set(key, value);
				legacyReplaced += 1;
			}

			// 3. Read back, then record progress.
			const back = await getV<unknown>(key);
			if (back === null || back.value !== value) {
				reportOnce("other");
				return "retry";
			}
			progress[key] = back.revision;
			await kv.set(PAYMENT_SECRETS_ENCRYPTION_PROGRESS_KEY, progress);
			resaved += 1;
		}

		// 4. The retired x402 secret: nothing reads it, so it goes.
		const retiredRemoved = (await kv.delete(X402_LEGACY_FACILITATOR_SECRET_KEY)) ? 1 : 0;

		// 5. Done.
		await kv.set(PAYMENT_SECRETS_ENCRYPTED_MARKER_KEY, PAYMENT_SECRETS_ENCRYPTED_MARKER_VALUE);
		await kv.delete(PAYMENT_SECRETS_ENCRYPTION_PROGRESS_KEY);
		doneInIsolate.add(site);
		console.info(
			`[otta] payment keys encrypted at rest: ${String(resaved)} re-saved, ` +
				`${String(legacyReplaced)} legacy copies replaced, ${String(retiredRemoved)} retired keys removed`,
		);
		return "encrypted";
	} catch (error) {
		reportOnce(isKeyProblem(error) ? "key" : "other");
		return "retry";
	}
}
