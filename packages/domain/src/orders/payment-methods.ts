/**
 * Which payment method a STORED value names. The stored value is read as a
 * `string`, never trusted as a `PaymentMethod`: an order placed before a method
 * was removed (x402) still carries it, and a hand-seeded or mistyped value
 * ("Stripe", "toString") is not current either. Every one of those is UNKNOWN
 * and fails closed wherever it is looked up.
 */
import type { PaymentGateway } from "../ports/payment-gateway.js";
import type { PaymentMethod } from "./model.js";

/**
 * How each payment method's money is confirmed (ADR-0026 Decision 1): by its
 * GATEWAY (Stripe's `payment_intent.succeeded`) or OFFLINE, by a person who saw
 * the money arrive. Only an `offline` method may be marked paid by hand.
 *
 * A `Record` over every `PaymentMethod` on purpose: a new method must declare
 * which kind it is. It is also the list of CURRENT methods — a stored value that
 * is not an own key here is unknown.
 *
 * `cod` (cash on delivery, ADR-0042) is offline: its order is placed with no
 * online payment, its stock stays with the order until a person marks it paid
 * (the cash arrived) or cancels it, and it never expires at a checkout hold.
 *
 * A method that refunds outside Otta also needs a refund-route declaration read by
 * markRefundedRefusal (removed in #502 while none existed). Cash on delivery does
 * not: a COD refund is recorded as a MANUAL refund in Money → Refunds (its gateway
 * is `refundable: false`), and Mark refunded stays decided by the ledger.
 */
export const PAYMENT_METHOD_SETTLEMENT: Readonly<Record<PaymentMethod, "gateway" | "offline">> = {
	stripe: "gateway",
	cod: "offline",
};

/** True iff `stored` is a current `PaymentMethod` (own key: "toString" is not). */
export function isCurrentPaymentMethod(stored: string): stored is PaymentMethod {
	return Object.hasOwn(PAYMENT_METHOD_SETTLEMENT, stored);
}

/**
 * True iff a STORED method is declared `offline` (ADR-0026 Decision 1, ADR-0042).
 * FAILS CLOSED: `null` (no method on file) and an unknown method are not offline.
 */
export function isOfflinePaymentMethod(stored: string | null): boolean {
	return (
		stored !== null &&
		isCurrentPaymentMethod(stored) &&
		PAYMENT_METHOD_SETTLEMENT[stored] === "offline"
	);
}

/**
 * The hold deadline an OFFLINE order is placed with (ADR-0042): the largest
 * ISO-8601 instant, so the order is never due for expiry and its adopted holds
 * (which carry the order's deadline) never lapse. An offline order has no
 * "time to pay" — the buyer pays on delivery — so its stock stays taken until a
 * person marks it paid (which commits it) or cancels it (which releases it).
 *
 * A value rather than a new nullable field, on purpose: every store already
 * compares the deadline as an ISO string (`listExpirable`, `expire`, the adopt
 * guard, the coupon leg), so no adapter, index or migration changes, and an
 * existing reader that renders it sees a date that is plainly "never".
 */
export const OFFLINE_HOLD_EXPIRES_AT = "9999-12-31T23:59:59.999Z";

/**
 * The `payments` row reference an offline payment is recorded under — one per
 * order, so a replayed Mark paid records nothing new (`recordPayment` is
 * idempotent on `providerRef`) and the order's `paidProviderRef` names it.
 */
export function offlinePaymentRef(method: PaymentMethod, orderId: string): string {
	return `offline:${method}:${orderId}`;
}

/**
 * The gateway wired for a stored method: only a current method's OWN key with a
 * defined value (`{ stripe: undefined }` is no gateway). An unknown or `null`
 * method has none.
 */
export function gatewayForStored(
	gateways: Partial<Record<PaymentMethod, PaymentGateway>>,
	stored: string | null,
): PaymentGateway | undefined {
	return stored !== null && isCurrentPaymentMethod(stored) && Object.hasOwn(gateways, stored)
		? gateways[stored]
		: undefined;
}
