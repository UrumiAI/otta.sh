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
 * WHAT AUTHORISES A RESUME: the order id, and nothing else — the same bearer
 * capability `/orders/<id>` reads with. The plugin's `storefront/order/resume`
 * answers only for a `pending` order before its hold deadline, and answers with
 * that order's OWN PaymentIntent (the original checkout replayed on its own key):
 * no second order, no second intent. What it grants beyond the order page is the
 * means to pay that order while it is payable. The email is shown only as a
 * hint (`j•••@g•••.com`), so the resumed page names no more of the buyer than
 * the order page does.
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
	/** Go to the order page, which says why there is nothing to pay here. */
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
