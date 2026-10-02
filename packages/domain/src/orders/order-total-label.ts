/**
 * What the figure under an order's totals is called, and how much of it the
 * ledger says went back — ONE pure rule for every customer surface (the order
 * page, the account's order page, the order emails), so they cannot drift.
 *
 * The total is labelled by whether it was PAID: "Paid" for every state the order
 * reaches only after its payment was captured — refunded included, because it
 * was paid — and "Total" for every other state (a figure, not a claim that money
 * moved). A refund is NOT said by relabelling the total: an admin's "Mark
 * refunded" records money returned outside Otta (ADR-0026), and a ledger refund
 * is capped at what was captured, which can be below the total — so "Refunded
 * $total" is not always true. The refund is said by the order's status, and,
 * where the ledger is read, by {@link recordedRefundTotal} as its own figure.
 */
import type { RefundRecord } from "../ports/order-store.js";

/** The states an order is in only after its payment was captured. */
const CAPTURED_STATES: ReadonlySet<string> = new Set([
	"paid",
	"processing",
	"shipped",
	"delivered",
	"completed",
	"refunded",
]);

export function orderTotalLabel(state: string): "Paid" | "Total" {
	return CAPTURED_STATES.has(state) ? "Paid" : "Total";
}

/**
 * Money the ledger shows returned: the sum of RECORDED refunds only — a reserved
 * or unverified row is a promise, not a refund (the rule `classifyLatePayment`
 * uses). In the refunds' own minor units; an order's refunds share its currency.
 */
export function recordedRefundTotal(
	refunds: readonly Pick<RefundRecord, "amount" | "status">[],
): number {
	let total = 0;
	for (const refund of refunds) if (refund.status === "recorded") total += refund.amount;
	return total;
}
