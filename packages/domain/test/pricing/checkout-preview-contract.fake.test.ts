import {
	checkoutPreviewContract,
	CountingIdGen,
	FixedClock,
	InMemoryCouponStore,
	InMemoryShippingRulesStore,
	InMemoryTaxRulesStore,
} from "@otta-sh/domain/testing";

checkoutPreviewContract(
	async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		return {
			deps: {
				shippingRules: new InMemoryShippingRulesStore(),
				taxRules: new InMemoryTaxRulesStore(),
				couponStore: new InMemoryCouponStore({ idGen: new CountingIdGen("red"), clock }),
				clock,
			},
		};
	},
	{ dialect: "fake" },
);
