/**
 * `GET /checkout/pay`'s entry guard — whether the page may mount a card form for
 * the order in the buyer's `otta_checkout` stash.
 *
 * WHY THE PAY PAGE NOW READS THE ORDER. It used to make no commerce call at all:
 * the stash carried everything it needed (order id, client secret, total). But the
 * stash outlives the order's hold — a buyer can keep the tab open, or come back to
 * it — and the client secret in it stays payable at Stripe until something
 * withdraws it. That is how an EXPIRED order got paid: Stripe captured, settlement
 * refused to revive the order, and the buyer was charged for stock already back on
 * sale. So the page now asks the order route (the same public, capability-scoped
 * read the confirmation page makes) and refuses a form for anything that cannot
 * take the money.
 *
 * DEFENCE IN DEPTH, NOT THE GUARANTEE. The server side holds the line on its own:
 * expiry cancels the PaymentIntent at Stripe, and a payment that lands on a dead
 * order anyway is refunded automatically. This guard only stops the buyer from
 * being walked into that — which is why an UNKNOWN answer (the dispatch failed,
 * storage is busy, a render guard tripped) renders the form rather than refusing
 * it: turning a storage hiccup into "you cannot pay" would be a checkout outage
 * bought for a case the backstops already cover.
 *
 * Like `checkout-redirect.ts`, it lives here rather than in the page because
 * `.astro` files have no render harness in this package (issue #40).
 */
import type { OrderRouteResult } from "@otta-sh/plugin";

/**
 * May the buyer pay this order NOW? Only a `pending` order, and only strictly
 * before its hold deadline. At or past the deadline the order is as good as
 * expired — the sweep simply has not run yet (and does not run at all in local
 * dev) — and its stock is about to be released. An unreadable deadline is not
 * payable: a card form is never mounted on a guess.
 */
export function isOrderPayable(
	order: { state: string; holdExpiresAt: string },
	now: Date,
): boolean {
	if (order.state !== "pending") return false;
	const deadline = Date.parse(order.holdExpiresAt);
	return Number.isFinite(deadline) && deadline > now.getTime();
}

/**
 * Where to send the buyer INSTEAD of the pay form, or `null` to render it.
 *
 * @param orderPath the stashed order's confirmation page — the one honest place
 *   to explain an order that cannot be paid (expired, cancelled, already paid)
 * @param result the `storefront/order` read, or `null` when the dispatch itself
 *   failed
 */
export function payPageRedirect(
	orderPath: string,
	result: OrderRouteResult | null,
	now: Date,
): string | null {
	if (result === null) return null;
	if (result.ok) return isOrderPayable(result.order, now) ? null : orderPath;
	// A DEFINITIVE "no such order" (a stale or hand-made stash) is not payable
	// either; its page says so with a 404. Every other failure — busy, a render
	// guard, malformed input we did not send — is "unknown", and unknown renders.
	return "reason" in result && result.reason === "ORDER_NOT_FOUND" ? orderPath : null;
}
