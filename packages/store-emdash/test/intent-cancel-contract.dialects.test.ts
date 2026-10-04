/**
 * The domain's `intentCancelContract` (late-payment PREVENTION) against the
 * document store, on both Node dialects: an intent recorded at checkout is due at
 * the order's hold, the paid flip resolves it, an unpaid cancel expedites it, and
 * the bounded intent-cancel sweep withdraws it once — rescheduling a transient
 * failure a bounded number of times — through the real `intentCancelDueAt` index.
 * D1 runs the same suite from `d1/intent-cancel-contract.d1.spec.ts`.
 */
import { intentCancelContract } from "@otta-sh/domain/testing";
import { PAYMENT_DECLINE_LAYOUT } from "./coupon-collections.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { makePaymentDeclineHarness } from "./payment-decline-harness.js";

describeEachDialect("intent cancel", (ctx) => {
	const bound = ctx.useStorage(PAYMENT_DECLINE_LAYOUT);
	intentCancelContract(() => makePaymentDeclineHarness(bound.storage), {
		dialect: ctx.dialect,
	});
});
