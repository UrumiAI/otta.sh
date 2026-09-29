/**
 * The domain's `paymentDeclineContract` (ADR-0022, issue #304) against the document
 * store, on both Node dialects: a declined payment leaves the order pending with its
 * stock held and its coupon consumed, a later success settles it cleanly, and an
 * order nobody pays is released by the expiry sweep exactly once. D1 runs the same
 * suite from `d1/payment-decline-contract.d1.spec.ts`.
 */
import { paymentDeclineContract } from "@otta-sh/domain/testing";
import { PAYMENT_DECLINE_LAYOUT } from "./coupon-collections.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { makePaymentDeclineHarness } from "./payment-decline-harness.js";

describeEachDialect("payment decline", (ctx) => {
	const bound = ctx.useStorage(PAYMENT_DECLINE_LAYOUT);
	paymentDeclineContract(() => makePaymentDeclineHarness(bound.storage), {
		dialect: ctx.dialect,
	});
});
