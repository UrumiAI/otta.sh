/**
 * Delete the email credentials earlier builds stored, ONCE (ADR-0031).
 *
 * Email now goes through the EmDash host's `ctx.email`, so nothing reads these
 * write-only keys any more — but a live API key left in kv is still a live key.
 * The first cron tick of an isolate deletes them, then writes a marker so no
 * later tick pays more than one kv read for this (and none after that, in the
 * same isolate).
 *
 * THE MARKER IS WRITTEN ONLY AFTER EVERY DELETE SUCCEEDED, so a kv failure part
 * way through is retried on a later tick. It never throws: a failed purge must
 * not take the sweep down. Only these four keys are touched — never a Stripe,
 * x402 or edge-token key.
 *
 * A SEPARATE, DROPPABLE CHANGE: this is the point of no return for a rollback to
 * a build that still sent through those providers.
 */
import type { PluginContext } from "../types.js";

/** Exactly the keys removed: the two API keys and their save generations. */
export const LEGACY_EMAIL_SECRET_KEYS = [
	"settings:emailApiKey",
	"settings:emailApiKeyGen",
	"settings:emailSmtp2goApiKey",
	"settings:emailSmtp2goApiKeyGen",
] as const;

/** Set once the purge has completed. */
export const LEGACY_EMAIL_PURGE_MARKER_KEY = "state:legacyEmailSecretsPurged";

let doneInIsolate = false;

/** TESTS ONLY: forget that this isolate already purged. */
export function resetLegacyEmailPurgeForTesting(): void {
	doneInIsolate = false;
}

/**
 * Purge the legacy email credentials unless that already happened. Resolves
 * `true` when this call deleted them, `false` otherwise (already done, or a kv
 * failure left the marker unset for a later retry).
 */
export async function purgeLegacyEmailSecrets(ctx: PluginContext): Promise<boolean> {
	if (doneInIsolate) return false;
	try {
		if ((await ctx.kv.get<unknown>(LEGACY_EMAIL_PURGE_MARKER_KEY)) !== null) {
			doneInIsolate = true;
			return false;
		}
		for (const key of LEGACY_EMAIL_SECRET_KEYS) await ctx.kv.delete(key);
		await ctx.kv.set(LEGACY_EMAIL_PURGE_MARKER_KEY, new Date().toISOString());
		doneInIsolate = true;
		return true;
	} catch {
		// Names nothing about any value; retried on a later tick.
		console.warn("[otta] could not purge the legacy email credentials yet; will retry");
		return false;
	}
}
