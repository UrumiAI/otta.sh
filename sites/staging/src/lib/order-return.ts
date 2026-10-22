/**
 * Stripe's return to the confirmation page, kept out of its URL (ADR-0012,
 * 2026-10-22 amendment).
 *
 * Stripe's Payment Element redirect appends `payment_intent`,
 * `payment_intent_client_secret` and `redirect_status` to our `return_url`. The
 * client secret, with the publishable key every checkout page carries, reads the
 * PaymentIntent back — including the `shipping` block, the buyer's name and
 * address. A thank-you link a buyer forwards, a synced history, an access log:
 * each would hold it. So the order page does not keep it: on arrival it records
 * the two values it actually uses — the intent id (the poll's key) and the status
 * (the copy's choice) — in a short-lived HttpOnly cookie for THIS order, and 303s
 * to the bare `/orders/<id>`. The secret is dropped, never stored.
 *
 * WHY A COOKIE AND NOT JUST DROPPING THEM. The page still needs to know "this
 * buyer just paid" for the length of the confirming poll and the "Check again"
 * after it (decision 5 and the 2026-10-02 third amendment); the URL used to
 * carry that, and now this does.
 *
 * ONLY A PAYMENT THAT WENT THROUGH IS RECORDED (`succeeded` or `processing`). A
 * failed or cancelled redirect (a bank-redirect method the buyer backed out of)
 * records nothing and clears any earlier record for the order, so the page shows
 * the order's own state — "awaiting payment" with its resume — instead of
 * "confirming" a payment that is not coming.
 *
 * ONE RECORD PER ORDER. The cookie's path is the order's own page, so a second
 * order paid in another tab neither overwrites this one nor rides its requests.
 *
 * A browser that refuses the cookie loses the confirming copy: right after paying
 * it sees "awaiting payment" until the webhook lands and a reload shows "paid".
 * Checkout itself already needs cookies (the cart, the `otta_checkout` stash).
 */
import type { CookieDeleter, CookieReader, CookieWriter } from "./checkout-cookie.js";

export const ORDER_RETURN_COOKIE_NAME = "otta_order_return";

/** Long enough to cover the hold (15 minutes) plus a late "Check again"; short
 *  enough that a link opened tomorrow reads as a plain order page. */
export const ORDER_RETURN_MAX_AGE_SECONDS = 60 * 60;

const STRIPE_RETURN_PARAMS = [
	"payment_intent",
	"payment_intent_client_secret",
	"redirect_status",
] as const;

/** Stripe's intent ids are `pi_` plus alphanumerics. */
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9]{1,250}$/;
/** The returns worth remembering: money that moved, or is moving. */
const PAID_STATUSES: ReadonlySet<string> = new Set(["succeeded", "processing"]);

export interface StripeReturn {
	paymentIntent: string;
	status: string;
}

/** Is any of Stripe's redirect parameters on this URL? Any one is enough to scrub. */
export function hasStripeReturn(url: URL): boolean {
	return STRIPE_RETURN_PARAMS.some((name) => url.searchParams.has(name));
}

/** The same path, with Stripe's parameters removed and the page's own (`error`) kept. */
export function orderPathWithoutStripeReturn(url: URL): string {
	const params = new URLSearchParams(url.searchParams);
	for (const name of STRIPE_RETURN_PARAMS) params.delete(name);
	const query = params.toString();
	return `${url.pathname}${query.length > 0 ? `?${query}` : ""}`;
}

/** The cookie's path: this order's own page, in the encoded form browsers match. */
function orderReturnPath(orderId: string): string {
	return `/orders/${encodeURIComponent(orderId)}`;
}

/**
 * Remember, for this order, that the buyer came back from a payment that went
 * through. HttpOnly (no script reads it), `SameSite=Lax` (it is written on
 * Stripe's top-level redirect back), path = this order's page so it rides no
 * other request. Any other return — failed, cancelled, malformed — records
 * nothing and clears an earlier record for this order.
 */
export function recordStripeReturn(
	cookies: CookieWriter & CookieDeleter,
	orderId: string,
	url: URL,
): void {
	const paymentIntent = url.searchParams.get("payment_intent") ?? "";
	const status = url.searchParams.get("redirect_status") ?? "";
	if (!PAYMENT_INTENT_ID.test(paymentIntent) || !PAID_STATUSES.has(status)) {
		cookies.delete(ORDER_RETURN_COOKIE_NAME, { path: orderReturnPath(orderId) });
		return;
	}
	cookies.set(ORDER_RETURN_COOKIE_NAME, `${orderId}/${paymentIntent}:${status}`, {
		httpOnly: true,
		secure: true,
		sameSite: "lax",
		path: orderReturnPath(orderId),
		maxAge: ORDER_RETURN_MAX_AGE_SECONDS,
	});
}

/** This order's recorded return, or `null` — none, another order's, or malformed. */
export function readStripeReturn(cookies: CookieReader, orderId: string): StripeReturn | null {
	const raw = cookies.get(ORDER_RETURN_COOKIE_NAME)?.value ?? "";
	const prefix = `${orderId}/`;
	if (!raw.startsWith(prefix)) return null;
	const rest = raw.slice(prefix.length);
	const split = rest.lastIndexOf(":");
	if (split <= 0) return null;
	const paymentIntent = rest.slice(0, split);
	const status = rest.slice(split + 1);
	if (!PAYMENT_INTENT_ID.test(paymentIntent) || !PAID_STATUSES.has(status)) return null;
	return { paymentIntent, status };
}

/** Drop this order's recorded return (see {@link returnPollIsOver}). */
export function forgetStripeReturn(cookies: CookieDeleter, orderId: string): void {
	cookies.delete(ORDER_RETURN_COOKIE_NAME, { path: orderReturnPath(orderId) });
}

/**
 * A recorded return only stands in for "just back from Stripe" while its bounded
 * poll runs. Once the poll has stopped and the order is STILL pending, the
 * payment did not settle it (a `processing` payment can fail later, and
 * `payment_intent.payment_failed` leaves the order pending and payable), so the
 * page offers the resume again and the record is dropped. Otherwise a stale or
 * planted record would hide "Complete payment" on every visit for the record's
 * hour, longer than the hold itself.
 */
export function returnPollIsOver(input: {
	returnedFromStripe: boolean;
	pending: boolean;
	polling: boolean;
}): boolean {
	return input.returnedFromStripe && input.pending && !input.polling;
}
