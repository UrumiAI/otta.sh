import { CountingIdGen, FixedClock } from "@otta-sh/domain/testing";
import {
	couponStoreContract,
	InMemoryCouponStore,
	InMemoryShippingRulesStore,
	InMemoryTaxRulesStore,
	shippingRulesStoreContract,
	taxRulesStoreContract,
} from "@otta-sh/domain/testing";

shippingRulesStoreContract(async () => ({ store: new InMemoryShippingRulesStore() }), {
	dialect: "fake",
});

taxRulesStoreContract(async () => ({ store: new InMemoryTaxRulesStore() }), { dialect: "fake" });

couponStoreContract(
	async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const store = new InMemoryCouponStore({ idGen: new CountingIdGen("red"), clock });
		return {
			store,
			async seedCoupon(row) {
				store.seedCouponRow(row);
			},
		};
	},
	{ dialect: "fake" },
);
