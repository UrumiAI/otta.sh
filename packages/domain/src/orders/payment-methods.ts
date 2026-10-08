/**
 * Which payment method a STORED value names. The stored value is read as a
 * `string`, never trusted as a `PaymentMethod`: an order placed before a method
 * was removed (a legacy x402 order) still carries it, and a hand-seeded or
 * mistyped value ("Stripe", "toString") is neither current nor legacy.
 */
import type { PaymentGateway } from "../ports/payment-gateway.js";
import type { PaymentMethod } from "./model.js";

/** Every current method. A `Record` over `PaymentMethod`, so a new one must be added. */
const CURRENT_PAYMENT_METHODS: Readonly<Record<PaymentMethod, true>> = { stripe: true };

/** True iff `stored` is a current `PaymentMethod` (own key: "toString" is not). */
export function isCurrentPaymentMethod(stored: string): stored is PaymentMethod {
	return Object.hasOwn(CURRENT_PAYMENT_METHODS, stored);
}

/** What a removed method declared, kept for the orders that still store it. */
export interface LegacyMethodFacts {
	refunds: "outside";
	settlement: "gateway";
}

/**
 * The payment methods Otta REMOVED that older orders may still store, by name,
 * with how each one's money was confirmed and goes back. A NAMED list, never an
 * open fallback: a stored method that is neither current nor listed here (a typo,
 * "Stripe", a hand-seeded value) fails CLOSED everywhere it is looked up — it
 * could be money a provider still holds (QA2 M4).
 *
 * x402 (HTTP 402, USDC on Base) was confirmed by its gateway and could not
 * refund automatically: its money goes back OUTSIDE Otta, and Mark refunded or a
 * recorded refund is how the admin says so.
 */
export const LEGACY_PAYMENT_METHODS: Readonly<Record<string, LegacyMethodFacts>> = Object.freeze({
	x402: Object.freeze({ refunds: "outside", settlement: "gateway" }),
});

/** True iff `stored` names a REMOVED method from {@link LEGACY_PAYMENT_METHODS}. */
export function isLegacyPaymentMethod(stored: string): boolean {
	return Object.hasOwn(LEGACY_PAYMENT_METHODS, stored);
}

/**
 * The gateway wired for a stored method: only a current method's OWN key with a
 * defined value (`{ stripe: undefined }` is no gateway). A legacy, unknown or
 * `null` method has none.
 */
export function gatewayForStored(
	gateways: Partial<Record<PaymentMethod, PaymentGateway>>,
	stored: string | null,
): PaymentGateway | undefined {
	return stored !== null && isCurrentPaymentMethod(stored) && Object.hasOwn(gateways, stored)
		? gateways[stored]
		: undefined;
}

/**
 * True iff every SUCCEEDED payment came through a named legacy method (or there
 * is none): only then is a legacy order's money really outside Otta. Money a
 * current provider captured goes back through that provider. A payment with no
 * `gateway` on file is not taken as legacy (fail closed).
 */
export function capturedOnlyThroughLegacy(
	payments: readonly { status: string; gateway?: string }[],
): boolean {
	return payments.every(
		(p) =>
			p.status !== "succeeded" || (p.gateway !== undefined && isLegacyPaymentMethod(p.gateway)),
	);
}
