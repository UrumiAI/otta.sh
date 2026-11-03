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
 * `cod` (cash on delivery, ADR-0044) is offline: its order is placed with no
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
 * How a STORED method's money is confirmed — `"gateway"` or `"offline"` — or
 * `null` for no method on file or an unknown one (fail closed). The public and
 * admin order wires carry it as `settlement`, so readers branch on the kind of
 * method, never on `=== "cod"` (ADR-0044).
 */
export function settlementOf(stored: string | null): "gateway" | "offline" | null {
	return stored !== null && isCurrentPaymentMethod(stored)
		? PAYMENT_METHOD_SETTLEMENT[stored]
		: null;
}

/**
 * True iff a STORED method is declared `offline` (ADR-0026 Decision 1, ADR-0044).
 * FAILS CLOSED: `null` (no method on file) and an unknown method are not offline.
 */
export function isOfflinePaymentMethod(stored: string | null): boolean {
	return settlementOf(stored) === "offline";
}

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
