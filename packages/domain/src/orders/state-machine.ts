import type { EmailTemplate } from "../ports/email-sender.js";
import type { OrderState } from "./model.js";

/**
 * The order state machine (Phase 5 §5) as a single exported map — the domain
 * and any UI both read this, never a scattered `if`. It is a **strict superset
 * of Phase 4's shipped transitions**: `pending → paid|failed|expired` are the
 * three Phase-4-authoritative rows, reproduced verbatim so the shared
 * "reject anything not listed" enforcement can never strand them again (the
 * dropped-`expired` regression, §11). Every other row is a Phase 5 addition.
 */
export const ORDER_STATE_MACHINE = {
	// Phase 4: pending → paid|failed|expired. Phase 5 adds pending → cancelled.
	pending: ["paid", "failed", "expired", "cancelled"],
	paid: ["processing", "completed", "cancelled", "refunded"],
	processing: ["shipped", "cancelled", "refunded"],
	shipped: ["delivered", "refunded"],
	delivered: ["completed", "refunded"],
	completed: ["refunded"],
	// Terminal states — no legal outbound transition.
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

/**
 * The email fired on entry to a state (Phase 5 §5/§6). `pending` (no entry
 * event) and `failed` have **no** template — the `pending → failed` asymmetry
 * is a deliberate, tracked follow-up (§9 Risk 8), not an oversight. `expired`
 * DOES get one (§5 email-on-`expired` decision).
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
 *  state has no customer-facing email (`failed`). */
export function emailTemplateForState(to: OrderState): EmailTemplate | null {
	return (ORDER_EMAIL_TEMPLATE_FOR_STATE as Partial<Record<OrderState, EmailTemplate>>)[to] ?? null;
}
