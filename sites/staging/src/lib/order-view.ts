/**
 * How an order is PRESENTED, shared by the public confirmation page
 * (`/orders/<id>`) and the account's own order page (`/account/orders/<id>`), so
 * the two pages cannot disagree about the same order (QA U-5).
 *
 * Pure, and here rather than in the pages because `.astro` has no render harness
 * in this package (issue #40): the rules are unit-tested (`order-view.test.ts`).
 */
import type { CheckoutTotalsView } from "@otta-sh/plugin";
import type { SumRow } from "./totals.js";

/**
 * The states an order is in only AFTER its payment was captured. `refunded` is
 * reached from these too, but its total is no longer what the shopper paid and
 * kept — see {@link orderTotalLabel}.
 */
const PAID_STATES: ReadonlySet<string> = new Set([
	"paid",
	"processing",
	"shipped",
	"delivered",
	"completed",
]);

/**
 * The total row's label: "Paid" for every state the money was captured in — a
 * shipped order's total is no less paid than a just-paid one's — and "Refunded"
 * for `refunded`, which the domain enters only when the refunds cover the order
 * in full. Everything else (pending, expired, failed, cancelled, a state this
 * site does not know) is a "Total": a figure, not a claim that money moved.
 *
 * A paid order with a PARTIAL refund stays `paid` and is labelled "Paid": the
 * figure is what was paid, and the public read carries no refunded amount to
 * say more with.
 */
export function orderTotalLabel(state: string): string {
	if (PAID_STATES.has(state)) return "Paid";
	if (state === "refunded") return "Refunded";
	return "Total";
}

/**
 * The totals rows, in reading order, off the plugin's built totals
 * (`buildCheckoutTotals` with `orderTotalsFlags`) — so "Not calculated" is the
 * plugin's call, never a $0.00 the page invents. The discount row names an
 * applied coupon, and says "No coupon applied" when there is none.
 */
export function orderSumRows(totals: CheckoutTotalsView): SumRow[] {
	return [
		{ label: "Subtotal", amount: totals.subtotal },
		{
			label:
				totals.appliedCouponCode !== null ? `Discount · ${totals.appliedCouponCode}` : "Discount",
			amount: totals.discount,
			fallback: "No coupon applied",
		},
		{ label: "Shipping", amount: totals.shipping },
		{ label: "Tax", amount: totals.tax },
	];
}

export interface OrderProgress {
	/** The step the order is at. */
	current: "payment" | "order";
	/** The journey stopped at `current`: it was not completed (expired, failed). */
	halted: boolean;
}

/**
 * Where the checkout tracker stands for an order — and the rule is that it never
 * says "Payment, completed" about an order nobody paid (QA U-13: an expired order
 * showed Cart, Details and Payment all done).
 *
 *  - paid and every state after it (refunded too: it was paid first) → at
 *    Order, Payment done;
 *  - `pending` → Payment is the step in progress;
 *  - `expired`, `failed` → stopped AT Payment, which the tracker says;
 *  - `cancelled`, or a state this site does not know → no tracker at all. A
 *    cancelled order may have been paid first or not, and the public read does
 *    not say which, so any position would be a guess.
 */
export function orderProgress(state: string): OrderProgress | null {
	if (PAID_STATES.has(state) || state === "refunded") return { current: "order", halted: false };
	if (state === "pending") return { current: "payment", halted: false };
	if (state === "expired" || state === "failed") return { current: "payment", halted: true };
	return null;
}
