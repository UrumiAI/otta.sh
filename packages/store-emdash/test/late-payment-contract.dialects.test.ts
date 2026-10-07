/**
 * The domain's `latePaymentContract` against the document store, on both Node
 * dialects: a success that lands on an order which provably left `pending` unpaid is
 * refunded exactly once across redeliveries, concurrent deliveries and sweep
 * resumes, its flag worded for the human and resolved when done, and ONE notice
 * carrying the refunded amount enqueued on the real outbox. It reuses the decline
 * harness — the same stores, shared between settle and expiry — so no new wiring
 * can drift from what ADR-0022 already proves. D1 runs the same suite from
 * `d1/late-payment-contract.d1.spec.ts`.
 */
import { latePaymentContract } from "@otta-sh/domain/testing";
import { PAYMENT_DECLINE_LAYOUT } from "./coupon-collections.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { makeLatePaymentHarness } from "./late-payment-harness.js";

describeEachDialect("late payment", (ctx) => {
	const bound = ctx.useStorage(PAYMENT_DECLINE_LAYOUT);
	latePaymentContract(() => makeLatePaymentHarness(bound.storage), {
		dialect: ctx.dialect,
	});
});
