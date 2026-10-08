/**
 * Delete the x402 settings earlier builds stored, ONCE.
 *
 * x402 is gone, so nothing reads these keys any more — but a facilitator API key
 * left in kv is still a live credential, and the pay-to wallet and networks are
 * dead configuration an operator would otherwise find in a database dump.
 *
 * These keys are all that x402 left in plugin kv: `settings:x402PayTo` and
 * `settings:x402Accepts` (the Settings fields), `settings:x402FacilitatorApiKey`
 * with its save generation `…Gen` (the write-only credential), and
 * `settings:x402FacilitatorSecret` (the earlier, superseded name of that
 * credential, deleted on the next save of the new one — a store that never saved
 * it again still holds it).
 *
 * Nothing else is touched: never a Stripe, email or edge-token key.
 *
 * COST: it runs outside the sweep tick's query budget (`cron/index.ts`). The
 * marker is read first, so a purged store pays one kv read per isolate
 * and none after that in the same isolate. A store that never had x402 settings
 * pays five idempotent deletes and one write, once.
 *
 * THE MARKER IS WRITTEN ONLY AFTER EVERY DELETE SUCCEEDED, so a kv failure part
 * way through is retried on a later tick. It never throws: a failed purge must
 * not take the sweep down. Deleting an absent key is a no-op.
 *
 * Kept in its own file, away from the other legacy-credential purge, so the two
 * changes merge independently.
 */
import type { PluginContext } from "../types.js";

/** Exactly the keys removed. */
export const LEGACY_X402_SETTING_KEYS = [
	"settings:x402PayTo",
	"settings:x402Accepts",
	"settings:x402FacilitatorApiKey",
	"settings:x402FacilitatorApiKeyGen",
	"settings:x402FacilitatorSecret",
] as const;

/** Set once the purge has completed. */
export const LEGACY_X402_PURGE_MARKER_KEY = "state:legacyX402SettingsPurged";

/** Set once this isolate has seen the store purged: no later tick reads kv for it. */
let doneInIsolate = false;

/** TESTS ONLY: forget that this isolate already purged. */
export function resetLegacyX402PurgeForTesting(): void {
	doneInIsolate = false;
}

/**
 * Purge the legacy x402 settings unless that already happened. Resolves `true`
 * when this call deleted them, `false` otherwise (already done, or a kv failure
 * left the marker unset for a later retry).
 */
export async function purgeLegacyX402Settings(ctx: PluginContext): Promise<boolean> {
	if (doneInIsolate) return false;
	try {
		// A string marker (what the purge writes) means done; `null` or `undefined`
		// (a host's "missing") means not yet.
		if (typeof (await ctx.kv.get<unknown>(LEGACY_X402_PURGE_MARKER_KEY)) === "string") {
			doneInIsolate = true;
			return false;
		}
		for (const key of LEGACY_X402_SETTING_KEYS) await ctx.kv.delete(key);
		await ctx.kv.set(LEGACY_X402_PURGE_MARKER_KEY, new Date().toISOString());
		doneInIsolate = true;
		return true;
	} catch {
		// Names nothing about any value; retried on a later tick.
		console.warn("[otta] could not purge the legacy x402 settings yet; will retry");
		return false;
	}
}
