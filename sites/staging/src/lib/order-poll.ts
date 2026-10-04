/**
 * The confirmation page's bounded poll (`/orders/<id>`, QA U-13).
 *
 * WHEN. Only while a change is actually expected: the buyer has just come back
 * from Stripe's redirect and the order is still `pending` — the webhook that
 * settles it is on its way. An order simply awaiting payment, or one past its
 * hold, is not about to change on its own, so it does not poll; it offers
 * "Check again".
 *
 * HOW, WITHOUT CLIENT JS (ADR-0012 decision 2). Each hop is
 * `<meta http-equiv="refresh" content="4">` with NO `url=`: it reloads the very
 * same URL, and browsers treat a navigation to the current URL as a REPLACEMENT
 * of the history entry rather than a new one (verified in Chromium; it is the
 * HTML standard's rule for same-URL navigations). The old poll counted its hops
 * in the URL, so every hop was a new URL — and a new entry: eight Backs to leave
 * the page. With the URL fixed, the count has to live somewhere else, and that
 * is this short-lived cookie, scoped to the order pages.
 *
 * Reloading the same URL also keeps Stripe's redirect parameters across hops,
 * so every hop shows the "confirming" copy (the old hop 2 onwards fell back to
 * "awaiting payment", with a resume button, mid-confirmation). The page still
 * never echoes them: the refresh names no URL at all.
 */
import type { CookieReader, CookieWriter } from "./checkout-cookie.js";

export const ORDER_POLL_COOKIE_NAME = "otta_order_poll";

/** At most this many hops (~30 s at four seconds each), then "Check again". */
export const MAX_ORDER_POLLS = 8;

/** Seconds between hops — the meta refresh's `content`. */
export const ORDER_POLL_SECONDS = 4;

/** Long enough to outlive the eight hops, short enough that a buyer reopening
 *  the page later starts a fresh count. */
const ORDER_POLL_COOKIE_MAX_AGE_SECONDS = 120;

/** A count no honest run of this page reaches; anything above it is garbage. */
const MAX_PLAUSIBLE_HOP = 10_000;

/**
 * What the count is kept FOR: this order and the payment the buyer came back
 * from (Stripe's `payment_intent` id — an identifier, not the client secret). A
 * second return within the cookie's lifetime — another card, another attempt —
 * is a new payment and gets its full run of polls instead of the first one's
 * leftovers.
 */
export function orderPollKey(orderId: string, paymentIntent: string | null): string {
	return paymentIntent === null || paymentIntent.length === 0
		? orderId
		: `${orderId}/${paymentIntent}`;
}

/** This render's hop: 1 on arrival, or one past the count the cookie holds for
 *  THIS key ({@link orderPollKey}). Anything malformed starts again at 1. */
export function orderPollHop(cookies: CookieReader, key: string): number {
	const raw = cookies.get(ORDER_POLL_COOKIE_NAME)?.value ?? "";
	const split = raw.lastIndexOf(":");
	if (split <= 0 || raw.slice(0, split) !== key) return 1;
	const digits = raw.slice(split + 1);
	if (!/^\d{1,5}$/.test(digits)) return 1;
	const last = Number(digits);
	return last >= 1 && last < MAX_PLAUSIBLE_HOP ? last + 1 : 1;
}

/**
 * Remember that this key's page rendered hop `hop`. HttpOnly (no script reads
 * it), `SameSite=Lax` because the first hop is Stripe's top-level redirect back,
 * and `path=/orders/` so it rides no other request.
 */
export function recordOrderPollHop(cookies: CookieWriter, key: string, hop: number): void {
	cookies.set(ORDER_POLL_COOKIE_NAME, `${key}:${String(hop)}`, {
		httpOnly: true,
		secure: true,
		sameSite: "lax",
		path: "/orders/",
		maxAge: ORDER_POLL_COOKIE_MAX_AGE_SECONDS,
	});
}

/** Poll only while a change is expected — a `pending` order the buyer has just
 *  paid for, or a dead one their payment reached late (until its refund is
 *  recorded) — and only so often. */
export function shouldPollOrder(input: {
	state: string | null;
	returnedFromStripe: boolean;
	hop: number;
	/** Stripe's return said the payment succeeded or is processing (QA2 M3). */
	returnedPaid?: boolean;
	/** The order's derived late-payment status, from its ledgers. */
	latePayment?: string;
}): boolean {
	if (!input.returnedFromStripe || input.hop > MAX_ORDER_POLLS) return false;
	if (input.state === "pending") return true;
	// QA2 M3: a payment made on an order that had already died. The webhook will
	// record it and the refund follows — poll (bounded, the same hops) until the
	// refund is on the ledger, so the page ends on the truth instead of "Nothing
	// was charged".
	return (
		input.returnedPaid === true &&
		(input.state === "expired" || input.state === "cancelled" || input.state === "failed") &&
		input.latePayment !== "refunded"
	);
}
