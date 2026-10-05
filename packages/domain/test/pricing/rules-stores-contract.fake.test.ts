import { describe, expect, test } from "vitest";
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

describe("InMemoryCouponStore.seedCouponRow — the restore path keeps the folded-code rule", () => {
	test("a case-variant of a live code is refused with the port's conflict error", () => {
		const store = new InMemoryCouponStore({
			idGen: new CountingIdGen("seed"),
			clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
		});
		store.seedCouponRow({ id: "a", code: "SAVE5", createdAt: "2026-07-10T00:00:00.000Z" });
		expect(() =>
			store.seedCouponRow({ id: "b", code: "save5", createdAt: "2026-07-10T00:00:01.000Z" }),
		).toThrow(expect.objectContaining({ code: "COUPON_CODE_CONFLICT" }));
		// Re-seeding the SAME row is a restore, not a conflict.
		expect(() =>
			store.seedCouponRow({ id: "a", code: "SAVE5", createdAt: "2026-07-10T00:00:00.000Z" }),
		).not.toThrow();
	});
});
