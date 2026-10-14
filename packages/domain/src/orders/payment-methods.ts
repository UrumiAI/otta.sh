/**
 * Which payment method a STORED value names. The stored value is read as a
 * `string`, never trusted as a `PaymentMethod`: an order placed before a method
 * was removed (x402) still carries it, and a hand-seeded or mistyped value
 * ("Stripe", "toString") is not current either. Every one of those is UNKNOWN
 * and fails closed wherever it is looked up.
 */
import type { PaymentGateway } from "../ports/payment-gateway.js";
import type { PaymentMethod } from "./model.js";

/** Every current method. A `Record` over `PaymentMethod`, so a new one must be added. */
const CURRENT_PAYMENT_METHODS: Readonly<Record<PaymentMethod, true>> = { stripe: true };

/** True iff `stored` is a current `PaymentMethod` (own key: "toString" is not). */
export function isCurrentPaymentMethod(stored: string): stored is PaymentMethod {
	return Object.hasOwn(CURRENT_PAYMENT_METHODS, stored);
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
