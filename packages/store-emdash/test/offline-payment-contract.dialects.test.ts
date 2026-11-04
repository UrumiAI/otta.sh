/**
 * The domain's `offlinePaymentContract` (ADR-0044, cash on delivery) against the
 * document store on both Node dialects: an offline order never expires, Mark paid
 * records the payment and commits its stock once, and cancel returns it. D1 runs
 * the same suite from `d1/offline-payment-contract.d1.spec.ts`.
 */
import { offlinePaymentContract } from "@urumi.ai/otta-domain/testing";
import { PAYMENT_DECLINE_LAYOUT } from "./coupon-collections.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { makePaymentDeclineHarness } from "./payment-decline-harness.js";

describeEachDialect("offline payment", (ctx) => {
	const bound = ctx.useStorage(PAYMENT_DECLINE_LAYOUT);
	offlinePaymentContract(() => makePaymentDeclineHarness(bound.storage), {
		dialect: ctx.dialect,
	});
});
