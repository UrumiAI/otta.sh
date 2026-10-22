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
 * buyer just came back from paying" for the length of the confirming poll and
 * the "Check again" after it (decision 5 and the 2026-10-02 third amendment);
 * the URL used to carry that, and now this does. A browser that refuses the
 * cookie sees the order's ordinary copy — its true state, without the
 * "confirming" wording — which is the same page a buyer opening the link later
 * gets.
 */
import type { CookieReader, CookieWriter } from "./checkout-cookie.js";

export const ORDER_RETURN_COOKIE_NAME = "otta_order_return";

/** Long enough to cover the hold (15 minutes) plus a late "Check again"; short
 *  enough that a link opened tomorrow reads as a plain order page. */
export const ORDER_RETURN_MAX_AGE_SECONDS = 60 * 60;

const STRIPE_RETURN_PARAMS = [
	"payment_intent",
	"payment_intent_client_secret",
	"redirect_status",
] as const;

/** Stripe's ids are `pi_` plus alphanumerics; its statuses are lowercase words. */
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9]{1,250}$/;
const REDIRECT_STATUS = /^[a-z_]{1,32}$/;

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

/**
 * Remember, for this order, that the buyer came back from Stripe and with what
 * status. HttpOnly (no script reads it), `SameSite=Lax` (it is written on Stripe's
 * top-level redirect back), `path=/orders/` so it rides no other request. A
 * malformed id or status records nothing.
 */
export function recordStripeReturn(cookies: CookieWriter, orderId: string, url: URL): void {
	const paymentIntent = url.searchParams.get("payment_intent") ?? "";
	const status = url.searchParams.get("redirect_status") ?? "";
	if (!PAYMENT_INTENT_ID.test(paymentIntent) || !REDIRECT_STATUS.test(status)) return;
	cookies.set(ORDER_RETURN_COOKIE_NAME, `${orderId}/${paymentIntent}:${status}`, {
		httpOnly: true,
		secure: true,
		sameSite: "lax",
		path: "/orders/",
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
	if (!PAYMENT_INTENT_ID.test(paymentIntent) || !REDIRECT_STATUS.test(status)) return null;
	return { paymentIntent, status };
}
