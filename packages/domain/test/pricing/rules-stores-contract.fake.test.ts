import { CountingIdGen } from "@urumi/domain/testing";
import {
	couponStoreContract,
	InMemoryCouponStore,
	InMemoryShippingRulesStore,
	InMemoryTaxRulesStore,
	shippingRulesStoreContract,
	taxRulesStoreContract,
} from "@urumi/domain/testing";

shippingRulesStoreContract(async () => ({ store: new InMemoryShippingRulesStore() }), {
	dialect: "fake",
});

taxRulesStoreContract(async () => ({ store: new InMemoryTaxRulesStore() }), { dialect: "fake" });

couponStoreContract(
	async () => ({ store: new InMemoryCouponStore({ idGen: new CountingIdGen("red") }) }),
	{ dialect: "fake" },
);
