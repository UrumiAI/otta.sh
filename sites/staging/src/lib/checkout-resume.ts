/**
 * Resuming a pending order's payment from its order page (QA U-2) — the
 * page-owned path the order page hands its theme, and what the resume endpoint
 * does with the plugin's answer.
 *
 * WHY NOT `/checkout`. "Complete payment" used to link to the review page, which
 * rebuilds the payment step from the CART cookie: on another device, or once the
 * cookie had rotated, it was a dead end; and where it worked, the locked review
 * showed an empty, editable email the replayed order silently ignored.
 *
 * WHAT AUTHORISES A RESUME: the order id PLUS a second factor. The id is a
 * bearer link that sits in mailboxes and histories, and the client secret a
 * resume hands out can read the order's ship-to back from Stripe, so the plugin
 * also wants one of: the cart the order was made from (this browser's cart
 * cookie), a session whose customer owns the order (the session cookie), or the
 * order's email, typed again on `/checkout/resume/email` (compared server-side,
 * guesses throttled per order). The plugin's `storefront/order/resume` answers
 * only for a `pending` order before its hold deadline, with that order's OWN
 * PaymentIntent (the original checkout replayed on its own key): no second
 * order, no second intent. The email is shown on the pay page only as a hint
 * (`j•••@g•••.com`).
 *
 * Like `pay-guard.ts`, the logic lives here because `.astro` and endpoint files
 * have no render harness in this package.
 */
import type { OrderResumeRouteResult } from "@otta-sh/plugin";
import { checkoutStashTotal, type CheckoutStash } from "./checkout-cookie.js";

export const RESUME_PATH = "/checkout/resume";

/** The order page's "Complete payment" target. */
export function resumeHref(orderId: string): string {
	return `${RESUME_PATH}?order=${encodeURIComponent(orderId)}`;
}

/** The small private page that asks for the order's email (the second factor
 *  on a device with neither the order's cart nor its owner's session). */
export const RESUME_EMAIL_PATH = "/checkout/resume/email";

/** The tokens that page explains — one generic sentence each, no more. */
export const RESUME_EMAIL_ERRORS: ReadonlySet<string> = new Set(["EMAIL_MISMATCH", "THROTTLED"]);

export function resumeEmailPath(orderId: string, error?: string): string {
	const query = new URLSearchParams({ order: orderId });
	if (error !== undefined && RESUME_EMAIL_ERRORS.has(error)) query.set("error", error);
	return `${RESUME_EMAIL_PATH}?${query.toString()}`;
}

export function orderPathFor(orderId: string): string {
	return `/orders/${encodeURIComponent(orderId)}`;
}

/** Failures the ORDER page explains beside the order (its own `?error=`). Every
 *  other refusal is the order's state, which that page already states. */
export const ORDER_PAGE_RESUME_ERRORS: ReadonlySet<string> = new Set([
	"PAYMENT_INTENT_FAILED",
	"SERVICE_UNAVAILABLE",
]);

export type ResumeOutcome =
	/** Stash this and go to the pay page. */
	| { kind: "pay"; stash: CheckoutStash }
	/** Go to the order page (which says why there is nothing to pay here), or to
	 *  the email page when the plugin wants the second factor. */
	| { kind: "order"; path: string };

/**
 * The plugin's answer → where the buyer goes. BUSY is the caller's (a 503 with
 * Retry-After), never mapped here.
 */
export function resumeOutcome(
	orderId: string,
	result: OrderResumeRouteResult | null,
): ResumeOutcome {
	const orderPath = orderPathFor(orderId);
	if (result === null) return { kind: "order", path: `${orderPath}?error=SERVICE_UNAVAILABLE` };
	if (!result.ok) {
		const reason = "reason" in result ? result.reason : undefined;
		if (reason === "PROOF_REQUIRED") return { kind: "order", path: resumeEmailPath(orderId) };
		if (reason !== undefined && RESUME_EMAIL_ERRORS.has(reason)) {
			return { kind: "order", path: resumeEmailPath(orderId, reason) };
		}
		return reason !== undefined && ORDER_PAGE_RESUME_ERRORS.has(reason)
			? { kind: "order", path: `${orderPath}?error=${reason}` }
			: { kind: "order", path: orderPath };
	}
	if (
		result.clientAction.kind !== "stripe_client_secret" ||
		result.clientAction.clientSecret.length === 0 ||
		result.orderId.length === 0
	) {
		return { kind: "order", path: orderPath };
	}
	const stash: CheckoutStash = {
		orderId: result.orderId,
		clientSecret: result.clientAction.clientSecret,
	};
	const total = checkoutStashTotal(result.total);
	if (total !== undefined) stash.total = total;
	if (typeof result.buyerRefHint === "string" && result.buyerRefHint.length > 0) {
		stash.emailHint = result.buyerRefHint;
	}
	return { kind: "pay", stash };
}

/**
 * A navigation another SITE started (a link or a form on someone else's page)
 * — `Sec-Fetch-Site: cross-site`. The resume endpoint answers it with the order
 * page rather than a pay page: a GET that writes the checkout stash must not be
 * something another site can make a browser do. Absent (older browsers, curl)
 * is not refused: the stash it writes is for an order the requester already
 * names by its capability.
 */
export function isCrossSiteNavigation(request: Request): boolean {
	return request.headers.get("sec-fetch-site") === "cross-site";
}
