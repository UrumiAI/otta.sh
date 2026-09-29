/**
 * The domain's `checkoutPreviewContract` (issue #305 — the shipping zone derived
 * from the buyer's address) against the EmDash rules and coupon stores, on every
 * Node dialect. What it proves here that the fake cannot: a zone's `regions`
 * list survives the document round trip in the shape the matcher reads, and the
 * derived zone's methods, rates and tax rates are all reachable through the
 * adapters' own reads.
 */
import { checkoutPreviewContract } from "@otta-sh/domain/testing";
import { COUPON_LAYOUT } from "./coupon-collections.js";
import { makeCouponHarness } from "./coupon-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { RULES_LAYOUT } from "./rules-collections.js";
import { makeShippingRulesHarness, makeTaxRulesHarness } from "./rules-harness.js";

describeEachDialect("checkout preview over the EmDash rules + coupon stores", (ctx) => {
	const bound = ctx.useStorage({ ...RULES_LAYOUT, ...COUPON_LAYOUT });
	checkoutPreviewContract(
		async () => {
			const shipping = makeShippingRulesHarness(bound.storage);
			const tax = makeTaxRulesHarness(bound.storage, { clock: shipping.clock });
			const coupons = makeCouponHarness(bound.storage, { clock: shipping.clock });
			return {
				deps: {
					shippingRules: shipping.store,
					taxRules: tax.store,
					couponStore: coupons.store,
					clock: shipping.clock,
				},
			};
		},
		{ dialect: ctx.dialect },
	);
});
