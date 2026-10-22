/**
 * Issue #531 — when a Stripe webhook last reached this store AND verified.
 *
 * "Card payments: ready." says the three values are saved; it cannot say that
 * Stripe's deliveries arrive and pass the signature check. A Dashboard endpoint
 * pointing elsewhere, or a wrong `whsec_`, leaves every order "Payment submitted"
 * with nothing telling the operator. So the settle route records the time of each
 * delivery whose signature verified, and Settings shows it ("never" is the
 * warning).
 *
 * One plain kv key, last-write-wins: an ISO time, not a secret and not a
 * setting. Written only AFTER verification, so a forged or misdirected delivery
 * can never make the line look healthy. The write is best-effort: a failure is
 * logged and never changes what Stripe hears.
 */
import type { PluginContext } from "../types.js";

export const STRIPE_WEBHOOK_LAST_VERIFIED_KEY = "state:stripeWebhookLastVerifiedAt";

/** Record a verified delivery at `nowMs`. Never throws. */
export async function recordStripeWebhookVerified(
	ctx: PluginContext,
	nowMs: number,
): Promise<void> {
	try {
		await ctx.kv.set(STRIPE_WEBHOOK_LAST_VERIFIED_KEY, new Date(nowMs).toISOString());
	} catch (err) {
		console.warn("[otta] could not record the last verified Stripe webhook:", err);
	}
}

/** Forget the recorded time — a new webhook signing secret starts from "never".
 *  Never throws: a failure is logged, and the save it follows still stands. */
export async function clearStripeWebhookLastVerified(ctx: PluginContext): Promise<void> {
	try {
		await ctx.kv.delete(STRIPE_WEBHOOK_LAST_VERIFIED_KEY);
	} catch (err) {
		console.warn("[otta] could not clear the last verified Stripe webhook:", err);
	}
}

export type StripeWebhookLastVerified =
	| { status: "never" }
	| { status: "at"; at: string }
	| { status: "unreadable" };

/** What is recorded. A missing or garbled record is "never"; a failed READ is
 *  `unreadable`, because "never" over a kv blip would be a false alarm. */
export async function readStripeWebhookLastVerified(
	ctx: PluginContext,
): Promise<StripeWebhookLastVerified> {
	let value: unknown;
	try {
		value = await ctx.kv.get<unknown>(STRIPE_WEBHOOK_LAST_VERIFIED_KEY);
	} catch {
		return { status: "unreadable" };
	}
	if (typeof value !== "string") return { status: "never" };
	const ms = Date.parse(value);
	return Number.isFinite(ms)
		? { status: "at", at: new Date(ms).toISOString() }
		: { status: "never" };
}

/** The Settings line, beside "Card payments: …". Within the nested-context budget (200). */
export function stripeWebhookLastVerifiedLine(found: StripeWebhookLastVerified): string {
	switch (found.status) {
		case "never":
			return "Last verified Stripe webhook: never.";
		case "unreadable":
			return "Last verified Stripe webhook: unknown (it couldn't be read). Reload to try again.";
		case "at":
			return `Last verified Stripe webhook: ${found.at.slice(0, 10)} ${found.at.slice(11, 16)} UTC.`;
	}
}
