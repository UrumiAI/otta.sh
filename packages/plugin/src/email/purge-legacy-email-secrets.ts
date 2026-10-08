/**
 * Delete the email credentials earlier builds stored, ONCE (ADR-0031).
 *
 * Email now goes through the EmDash host's `ctx.email`, so nothing reads these
 * write-only keys any more — but a live API key left in kv is still a live key.
 *
 * ONLY ONCE A HOST PROVIDER HAS WORKED (PR #418 review, item 1). The keys are
 * what a rollback to an earlier build sends with, so they stay until the host
 * has ACCEPTED a send (`emailSendingStatus` is `confirmed`): `ctx.email` is
 * there, and a send went through it more recently than any "no provider"
 * answer. A store still choosing a provider (a Node-hosted one writing its own,
 * say) keeps the rollback path until its first email goes out.
 *
 * Then a tick deletes them and writes a marker, so no later tick pays more than
 * one kv read for this (and none after that, in the same isolate).
 *
 * COST: it runs outside the tick's query budget (`cron/index.ts`). With no
 * `ctx.email`: nothing. Otherwise the marker read first (a purged store stops
 * there, once per site per isolate); until a send is confirmed, that and the two
 * status reads at most once per {@link UNCONFIRMED_RECHECK_MS} per isolate — not
 * every tick, so an idle store with no provider stays cheap. Then four deletes
 * and one write, once — well inside the host's slack on Workers Free.
 *
 * THE MARKER IS WRITTEN ONLY AFTER EVERY DELETE SUCCEEDED, so a kv failure part
 * way through is retried on a later tick. It never throws: a failed purge must
 * not take the sweep down. Only these four keys are touched — never a Stripe,
 * x402 or edge-token key.
 *
 * A SEPARATE, DROPPABLE CHANGE: this is the point of no return for a rollback to
 * a build that still sent through those providers.
 */
import { TRANSPORT_UNAVAILABLE_RETRY_MS } from "@otta-sh/domain";
import type { PluginContext } from "../types.js";
import { emailSendingStatus } from "./ctx-email-sender.js";

/** Exactly the keys removed: the two API keys and their save generations. */
export const LEGACY_EMAIL_SECRET_KEYS = [
	"settings:emailApiKey",
	"settings:emailApiKeyGen",
	"settings:emailSmtp2goApiKey",
	"settings:emailSmtp2goApiKeyGen",
] as const;

/** Set once the purge has completed. */
export const LEGACY_EMAIL_PURGE_MARKER_KEY = "state:legacyEmailSecretsPurged";

/**
 * The sites this isolate has already seen purged, by site URL (`ctx.site.url`;
 * "" where the host gives none). Per site, not one flag, in case an isolate ever
 * serves more than one site's plugin kv (security review F3).
 */
const doneInIsolate = new Set<string>();

/** How long an "not confirmed yet" answer is trusted before the next look — the
 *  "no provider" record's own window (PR #418 review r3, F1). */
export const UNCONFIRMED_RECHECK_MS = TRANSPORT_UNAVAILABLE_RETRY_MS;

/** Per site: when this isolate may next look, after a "not confirmed yet". */
const nextLookAt = new Map<string, number>();

/** TESTS ONLY: forget which sites this isolate already purged or looked at. */
export function resetLegacyEmailPurgeForTesting(): void {
	doneInIsolate.clear();
	nextLookAt.clear();
}

/**
 * Purge the legacy email credentials unless that already happened. Resolves
 * `true` when this call deleted them, `false` otherwise (already done, no host
 * provider confirmed yet, or a kv failure left the marker unset for a later
 * retry).
 */
export async function purgeLegacyEmailSecrets(
	ctx: PluginContext,
	nowMs: number = Date.now(),
): Promise<boolean> {
	const site = ctx.site?.url ?? "";
	if (doneInIsolate.has(site)) return false;
	// No provider at all (trusted mode): nothing to confirm, not even a read.
	if (ctx.email === undefined) return false;
	if (nowMs < (nextLookAt.get(site) ?? 0)) return false;
	try {
		// A string marker (what the purge writes) means done; `null` or `undefined`
		// (a host's "missing") means not yet.
		if (typeof (await ctx.kv.get<unknown>(LEGACY_EMAIL_PURGE_MARKER_KEY)) === "string") {
			doneInIsolate.add(site);
			return false;
		}
		// Never before a host provider has delivered: until then a rollback must
		// still find its keys. Fail-soft inside: unreadable ⇒ not confirmed ⇒ wait.
		//
		// ONE GAP, ACCEPTED: an `email:beforeSend` hook that cancels a send makes the
		// host resolve it as sent, so `emailLastSentAt` (and with it `confirmed` and
		// this purge) can happen with nothing delivered. Cancelling every send is a
		// deliberate site choice, not a missing provider.
		if ((await emailSendingStatus(ctx, nowMs)) !== "confirmed") {
			nextLookAt.set(site, nowMs + UNCONFIRMED_RECHECK_MS);
			return false;
		}
		for (const key of LEGACY_EMAIL_SECRET_KEYS) await ctx.kv.delete(key);
		await ctx.kv.set(LEGACY_EMAIL_PURGE_MARKER_KEY, new Date().toISOString());
		doneInIsolate.add(site);
		return true;
	} catch {
		// Names nothing about any value; retried on a later tick.
		console.warn("[otta] could not purge the legacy email credentials yet; will retry");
		return false;
	}
}
