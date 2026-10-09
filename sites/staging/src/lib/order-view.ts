/**
 * How an order is PRESENTED, shared by the public confirmation page
 * (`/orders/<id>`) and the account's own order page (`/account/orders/<id>`), so
 * the two pages cannot disagree about the same order (QA U-5).
 *
 * Pure, and here rather than in the pages because `.astro` has no render harness
 * in this package (issue #40): the rules are unit-tested (`order-view.test.ts`).
 */
import type { CheckoutTotalsView, OrderRouteResult } from "@otta-sh/plugin";
import type { SumRow } from "./totals.js";

/** The states in which the order was paid — the tracker's "Payment done". */
const PAID_STATES: ReadonlySet<string> = new Set([
	"paid",
	"processing",
	"shipped",
	"delivered",
	"completed",
]);

/* The total's LABEL is not here: it is the domain's `orderTotalLabel` (through
   `@otta-sh/plugin`), shared with the order emails so the three surfaces cannot
   drift. */

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
			label: "Discount",
			...(totals.appliedCouponCode !== null ? { code: totals.appliedCouponCode } : {}),
			amount: totals.discount,
			fallback: "No coupon applied",
		},
		{ label: "Shipping", amount: totals.shipping },
		// ADR-0032: the view model's tax rows (today's single "Tax" row for every
		// order not priced with tax-inclusive prices). Labels render escaped.
		...totals.taxRows.map((row) => ({ label: row.label, amount: row.amount })),
		// ADR-0035's amendment: the total rounded to its currency's payment increment
		// (KWD, BHD, OMR, JOD), signed; only when non-zero.
		...(totals.rounding !== undefined ? [{ label: "Rounding", amount: totals.rounding }] : []),
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

/** A fault, and the fail-safe answer for anything off the route's contract. */
const UNAVAILABLE = { status: 503, failure: "SERVICE_UNAVAILABLE" } as const;

/**
 * What the public order page (`/orders/<id>`) answers for its one order read: the
 * HTTP status, and the error token whose copy the page prints when there is no
 * order. The status is the machine-readable half of that sentence, so the two
 * are decided together (issue #381):
 *
 *  - an order → 200;
 *  - no such order (`ORDER_NOT_FOUND`, or a malformed call — `INVALID_INPUT`,
 *    which names no order either) → 404 and "could not be found". One sentence
 *    for both, so the 404 says nothing about whether an order exists beyond what
 *    the id itself is: the capability IS the id (ADR-0010 §2);
 *  - BUSY (storage contention, already retried once by the dispatch) → 503 and
 *    the busy copy. The page adds #338's short `Retry-After` through `markBusy`;
 *  - a fault — `RENDER_FAILED` (the plugin's render guard caught a throw: a
 *    storage error, a defect, a malformed record), or a dispatch that answered
 *    nothing at all → 503 and the generic "try again shortly". It used to be a
 *    404, which told a crawler, a proxy and monitoring that a live order's
 *    address names nothing. No `Retry-After`: unlike BUSY, the page cannot know
 *    the fault is transient, so it names no time — as the account's order pages
 *    answer the same `RENDER_FAILED` (`account/orders/`).
 *
 * Both switches (`reason`, then `error`) are exhaustive on purpose: a new
 * failure the route can return has to be placed in one of these arms before the
 * site compiles. At runtime, an answer off the contract (an unknown token, a
 * bare `{ ok: false }`) fails safe to the fault's 503 — never a 200, and never a
 * 404 that would call a live order's address empty.
 */
export function orderReadOutcome(result: OrderRouteResult | null): {
	status: 200 | 404 | 503;
	failure: "ORDER_NOT_FOUND" | "BUSY" | "SERVICE_UNAVAILABLE" | null;
} {
	if (result === null) return UNAVAILABLE;
	if (result.ok) return { status: 200, failure: null };
	if ("reason" in result) {
		switch (result.reason) {
			case "ORDER_NOT_FOUND":
				return { status: 404, failure: "ORDER_NOT_FOUND" };
			default: {
				const unplaced: never = result.reason;
				void unplaced;
				return UNAVAILABLE;
			}
		}
	}
	switch (result.error) {
		case "INVALID_INPUT":
			return { status: 404, failure: "ORDER_NOT_FOUND" };
		case "BUSY":
			return { status: 503, failure: "BUSY" };
		case "RENDER_FAILED":
			return UNAVAILABLE;
		default: {
			const unplaced: never = result;
			void unplaced;
			return UNAVAILABLE;
		}
	}
}
