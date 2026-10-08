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
 * `settings:x402FacilitatorSecret` with its save generation
 * `settings:x402FacilitatorSecretGen` (the earlier, superseded name of that
 * credential, deleted on the next save of the new one — a store that never saved
 * it again still holds it; the generation key was written by the builds between
 * 36b959b5 and 8dbad306).
 *
 * Nothing else is touched: never a Stripe, email or edge-token key.
 *
 * COST: it runs outside the sweep tick's query budget (`cron/index.ts`), and
 * never on the tick where the email purge did its own deletes — that tick is
 * already paying for one purge, so this one waits for the next. The marker is
 * read first, so a purged store pays one kv read per site per isolate and none
 * after that in the same isolate. A store that never had x402 settings pays six
 * idempotent deletes, issued together, and one write, once.
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
	"settings:x402FacilitatorSecretGen",
] as const;

/** Set once the purge has completed. */
export const LEGACY_X402_PURGE_MARKER_KEY = "state:legacyX402SettingsPurged";

/**
 * The sites this isolate has already seen purged, by site URL (`ctx.site.url`;
 * "" where the host gives none): no later tick reads kv for them. Per site, not
 * one flag, in case an isolate ever serves more than one site's plugin kv — as
 * the email purge does.
 */
const doneInIsolate = new Set<string>();

/** TESTS ONLY: forget which sites this isolate already purged. */
export function resetLegacyX402PurgeForTesting(): void {
	doneInIsolate.clear();
}

/**
 * Purge the legacy x402 settings unless that already happened. Resolves the same
 * shape as the email purge (`LegacyEmailPurgeOutcome`): `purged` when this call
 * deleted them, `attempted` when a kv failure stopped it part way (the marker is
 * unset, so a later tick retries), `idle` when it deleted nothing (already done,
 * or the marker read failed).
 */
export async function purgeLegacyX402Settings(
	ctx: PluginContext,
): Promise<"purged" | "attempted" | "idle"> {
	const site = ctx.site?.url ?? "";
	if (doneInIsolate.has(site)) return "idle";
	let deleting = false;
	try {
		// A string marker (what the purge writes) means done; `null` or `undefined`
		// (a host's "missing") means not yet.
		if (typeof (await ctx.kv.get<unknown>(LEGACY_X402_PURGE_MARKER_KEY)) === "string") {
			doneInIsolate.add(site);
			return "idle";
		}
		deleting = true;
		// Independent keys: deleted together. Any rejection skips the marker below.
		await Promise.all(LEGACY_X402_SETTING_KEYS.map((key) => ctx.kv.delete(key)));
		await ctx.kv.set(LEGACY_X402_PURGE_MARKER_KEY, new Date().toISOString());
		doneInIsolate.add(site);
		return "purged";
	} catch {
		// Names nothing about any value; retried on a later tick.
		console.warn("[otta] could not purge the legacy x402 settings yet; will retry");
		return deleting ? "attempted" : "idle";
	}
}
