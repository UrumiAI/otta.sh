import {
	CountingIdGen,
	entitlementStoreContract,
	FixedClock,
	InMemoryEntitlementStore,
} from "@urumi/domain/testing";

entitlementStoreContract(
	() => {
		const store = new InMemoryEntitlementStore({
			idGen: new CountingIdGen("ent"),
			clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
		});
		return Promise.resolve({
			store,
			revoke(orderId: string) {
				store.revokeByOrder(orderId);
				return Promise.resolve();
			},
		});
	},
	{ dialect: "fake" },
);
