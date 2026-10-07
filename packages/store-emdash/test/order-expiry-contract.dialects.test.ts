/**
 * The domain's `orderExpiryContract` (QA2 M2) against the document store, on both
 * Node dialects: the expiry use-case flips and reads in one store call, never
 * re-reads the order, and leaves the hold release to the store's own completion
 * (`holdsReleased: true`), while every adopted hold still returns exactly once. D1
 * runs the same suite from `d1/order-expiry-contract.d1.spec.ts`.
 */
import { orderExpiryContract } from "@otta-sh/domain/testing";
import { PAYMENT_DECLINE_LAYOUT } from "./coupon-collections.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { makePaymentDeclineHarness } from "./payment-decline-harness.js";

describeEachDialect("order expiry", (ctx) => {
	const bound = ctx.useStorage(PAYMENT_DECLINE_LAYOUT);
	orderExpiryContract(() => makePaymentDeclineHarness(bound.storage), {
		dialect: ctx.dialect,
	});
});
