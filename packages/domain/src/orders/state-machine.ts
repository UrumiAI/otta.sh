import type { EmailTemplate } from "../ports/email-sender.js";
import type { OrderState } from "./model.js";

/**
 * The order state machine (Phase 5 §5) as a single exported map — the domain
 * and any UI both read this, never a scattered `if`. `pending → paid|expired`
 * are the Phase-4-authoritative rows, reproduced verbatim so the shared
 * "reject anything not listed" enforcement can never strand them again (the
 * dropped-`expired` regression, §11). Every other row is a Phase 5 addition.
 *
 * `pending → failed` is GONE (ADR-0021): a declined payment keeps the order
 * `pending` — the PaymentIntent is still payable — and an unpaid order leaves
 * `pending` only by expiring or being cancelled. Both release its stock. Only
 * expiry releases its coupon (`expireOrders`, with the coupon sweeper's `expired`
 * arm as the retry); `cancelOrder` deliberately releases no coupon. `failed` stays a STATE, terminal and unreachable, because orders
 * failed before ADR-0021 still carry it and every reader must keep rendering them.
 */
export const ORDER_STATE_MACHINE = {
	// Phase 4: pending → paid|expired. Phase 5 adds pending → cancelled.
	pending: ["paid", "expired", "cancelled"],
	paid: ["processing", "completed", "cancelled", "refunded"],
	processing: ["shipped", "cancelled", "refunded"],
	shipped: ["delivered", "refunded"],
	delivered: ["completed", "refunded"],
	completed: ["refunded"],
	// Terminal states — no legal outbound transition. `failed` has no inbound one
	// either: it survives only on orders written before ADR-0021.
	failed: [],
	expired: [],
	cancelled: [],
	refunded: [],
} as const satisfies Record<OrderState, readonly OrderState[]>;

/** True iff `from → to` is in the enforced table. Anything else is rejected by
 *  the domain use-case with `INVALID_TRANSITION`, never silently coerced. */
export function isLegalOrderTransition(from: OrderState, to: OrderState): boolean {
	return (ORDER_STATE_MACHINE[from] as readonly OrderState[]).includes(to);
}

/** The legal outbound transitions from `from` (empty for a terminal state). The
 *  admin Orders console reads this to render exactly the transition buttons the
 *  domain will accept — the single source of truth, never a UI-side re-listing. */
export function legalNextStates(from: OrderState): readonly OrderState[] {
	return ORDER_STATE_MACHINE[from];
}

/**
 * The email fired on entry to a state (Phase 5 §5/§6). `pending` (no entry
 * event) and `failed` (no longer entered at all, ADR-0021) have **no**
 * template. `expired` DOES get one (§5 email-on-`expired` decision) — and since
 * an order whose payment was declined and never retried now ends `expired`,
 * that is the email such a buyer receives.
 */
export const ORDER_EMAIL_TEMPLATE_FOR_STATE = {
	paid: "order-confirmation",
	processing: "order-processing",
	shipped: "order-shipped",
	delivered: "order-delivered",
	completed: "order-completed",
	cancelled: "order-cancelled",
	refunded: "order-refunded",
	expired: "order-expired",
} as const satisfies Partial<Record<OrderState, EmailTemplate>>;

/** The template to enqueue when an order enters `to`, or `null` when that
 *  state has no customer-facing email (`pending`, `failed`). */
export function emailTemplateForState(to: OrderState): EmailTemplate | null {
	return (ORDER_EMAIL_TEMPLATE_FOR_STATE as Partial<Record<OrderState, EmailTemplate>>)[to] ?? null;
}
