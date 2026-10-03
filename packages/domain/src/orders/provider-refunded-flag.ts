/**
 * The start of the reconciliation flag `refundOrder` writes when the provider's
 * pre-flight reports the payment ALREADY refunded (refunded outside Otta, e.g. in
 * the Stripe dashboard). It is the evidence that lets Mark refunded close such an
 * order (QA2 M4, ADR-0026 amended 2026-10-03). Its own module so `refund-order.ts`
 * and `transition.ts`, which already imports from it, share it without a cycle.
 */
export const PROVIDER_REFUNDED_FLAG_PREFIX = "Provider shows this payment already refunded";
