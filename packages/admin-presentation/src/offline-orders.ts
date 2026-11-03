/**
 * Cash on delivery in the console (ADR-0044): the Mark paid buttons, their
 * confirm, and the list's payment badge. Every rule here reads the order's
 * `settlement` — how its money is confirmed — and never the method's name, so
 * a second offline method needs no change here.
 */
import { paymentMethodLabel } from "./order-refund-copy.js";

/** The order's `settlement` as the wire carries it; absent from an older server. */
export type Settlement = "gateway" | "offline" | null;

export interface TransitionContext {
	/** The order's state now. */
	readonly fromState: string;
	readonly settlement?: Settlement | undefined;
}

/**
 * Is this transition an offline Mark paid — a person attesting the cash — rather
 * than a bookkeeping move? `→ paid` from an unpaid offline order, and
 * `shipped_awaiting_payment → delivered` (the courier collected it). An offline
 * order still `pending` (its placement crashed before the flip to
 * `awaiting_payment`) can be marked paid too, and records cash the same way
 * (B-N9). The console confirms these first.
 */
export function isOfflineMarkPaid(toState: string, context: TransitionContext): boolean {
	if (context.settlement !== "offline") return false;
	if (toState === "paid") {
		return context.fromState === "awaiting_payment" || context.fromState === "pending";
	}
	return toState === "delivered" && context.fromState === "shipped_awaiting_payment";
}

/** A transition button's label. The offline moves say what the operator is
 *  recording; every other move keeps its `Mark <state>`. */
export function transitionButtonLabel(toState: string, context: TransitionContext): string {
	if (isOfflineMarkPaid(toState, context)) {
		return toState === "delivered" ? "Mark paid (delivered)" : "Mark paid";
	}
	if (toState === "shipped_awaiting_payment") return "Mark shipped (unpaid)";
	return `Mark ${toState}`;
}

/** The confirm before an offline Mark paid (review finding 5): it records a
 *  payment on the ledger and emails the buyer, on the operator's word alone. */
export function markPaidConfirm(total: string): {
	readonly title: string;
	readonly text: string;
	readonly confirm: string;
	readonly deny: string;
} {
	return {
		title: "Mark this order paid?",
		text: `Confirm you received ${total} in cash. This records the payment and emails the buyer.`,
		confirm: "Yes, mark paid",
		deny: "Not yet",
	};
}

/** The badge an offline order wears on the list — its method's name — or null
 *  for any other order, and for a server too old to send `settlement`. */
export function offlinePaymentBadge(order: {
	readonly settlement?: Settlement | undefined;
	readonly paymentMethod: string | null;
}): string | null {
	return order.settlement === "offline" ? paymentMethodLabel(order.paymentMethod) : null;
}
