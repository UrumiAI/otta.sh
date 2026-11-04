import type { EmailTemplate } from "../ports/email-sender.js";
import type { OrderNotice, OrderState } from "./model.js";

/**
 * The order state machine (Phase 5 §5) as a single exported map — the domain
 * and any UI both read this, never a scattered `if`. `pending → paid|expired`
 * are the Phase-4-authoritative rows, reproduced verbatim so the shared
 * "reject anything not listed" enforcement can never strand them again (the
 * dropped-`expired` regression, §11). Every other row is a Phase 5 addition.
 *
 * `pending → failed` is GONE (ADR-0022): a declined payment keeps the order
 * `pending` — the PaymentIntent is still payable — and an unpaid order leaves
 * `pending` only by expiring or being cancelled. Both release its stock. Only
 * expiry releases its coupon (`expireOrders`, with the coupon sweeper's `expired`
 * arm as the retry); `cancelOrder` deliberately releases no coupon. `failed` stays a STATE, terminal and unreachable, because orders
 * failed before ADR-0022 still carry it and every reader must keep rendering them.
 */
export const ORDER_STATE_MACHINE = {
	// Phase 4: pending → paid|expired. Phase 5 adds pending → cancelled. ADR-0044
	// adds pending → awaiting_payment (an offline order, placed).
	pending: ["paid", "expired", "cancelled", "awaiting_payment"],
	// ADR-0044 — an offline (cash-on-delivery) order. Every move into or out of
	// these is offline-only (`isOfflineOnlyMove`); into `paid`/`delivered` is Mark
	// paid, a recorded payment.
	awaiting_payment: ["paid", "shipped_awaiting_payment", "cancelled"],
	shipped_awaiting_payment: ["delivered", "cancelled"],
	paid: ["processing", "completed", "cancelled", "refunded"],
	processing: ["shipped", "cancelled", "refunded"],
	shipped: ["delivered", "refunded"],
	delivered: ["completed", "refunded"],
	completed: ["refunded"],
	// Terminal states — no legal outbound transition. `failed` has no inbound one
	// either: it survives only on orders written before ADR-0022.
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
 * event) and `failed` (no longer entered at all, ADR-0022) have **no**
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
	// ADR-0044: "order received — pay in cash on delivery", with the amount due.
	awaiting_payment: "order-placed-offline",
	// The shipped email with tracking; it adds the amount due (render.ts).
	shipped_awaiting_payment: "order-shipped",
} as const satisfies Partial<Record<OrderState, EmailTemplate>>;

/** The template to enqueue when an order enters `to`, or `null` when that
 *  state has no customer-facing email (`pending`, `failed`). */
export function emailTemplateForState(to: OrderState): EmailTemplate | null {
	return (ORDER_EMAIL_TEMPLATE_FOR_STATE as Partial<Record<OrderState, EmailTemplate>>)[to] ?? null;
}

/**
 * The email each NON-transition notice renders (see `OrderNotice`). A sibling of
 * {@link ORDER_EMAIL_TEMPLATE_FOR_STATE} rather than a row in it: a notice is not
 * entered, it is enqueued alongside whatever state the order is already in, and
 * the dispatcher must never confuse "the order expired" with "a payment that
 * arrived after it expired came back to you".
 */
export const ORDER_NOTICE_EMAIL_TEMPLATE = {
	"late-payment-refunded": "order-late-payment-refunded",
	"refund-issued": "order-refund-issued",
} as const satisfies Record<OrderNotice, EmailTemplate>;

/** The template a notice outbox row renders. Total over `OrderNotice`. */
export function emailTemplateForNotice(notice: OrderNotice): EmailTemplate {
	return ORDER_NOTICE_EMAIL_TEMPLATE[notice];
}

/**
 * ADR-0044: the moves only an OFFLINE order may make — into or out of the two
 * unpaid offline states. `transitionOrder` and `transitionOrderAsAdmin` refuse
 * them (`INVALID_TRANSITION`) for any other order, so a card order can never be
 * parked unpaid or "paid" by a hand-made request.
 */
export function isOfflineOnlyMove(from: OrderState, to: OrderState): boolean {
	return OFFLINE_UNPAID_STATES.has(from) || OFFLINE_UNPAID_STATES.has(to);
}

/** The unpaid offline states (ADR-0044) — "open" for the caps, never revenue. */
export const OFFLINE_UNPAID_STATES: ReadonlySet<OrderState> = new Set([
	"awaiting_payment",
	"shipped_awaiting_payment",
]);

/**
 * ADR-0044: the state an offline order's Mark paid lands in, from where it is —
 * `awaiting_payment → paid`, `shipped_awaiting_payment → delivered` (the courier
 * collected the cash at the door) — or `null` where Mark paid does not apply.
 */
export function offlinePaidTarget(from: OrderState): "paid" | "delivered" | null {
	if (from === "awaiting_payment" || from === "pending") return "paid";
	if (from === "shipped_awaiting_payment") return "delivered";
	return null;
}
