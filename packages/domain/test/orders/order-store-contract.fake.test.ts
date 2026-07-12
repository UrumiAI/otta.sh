import {
	CountingIdGen,
	FixedClock,
	InMemoryOrderStore,
	orderStoreContract,
} from "@urumi/domain/testing";

// orderStoreContract against the in-memory fake — the first adapter, proving the
// suite is real and the port shape is right before any DB (§8 step 4.4).
orderStoreContract(
	() => {
		const store = new InMemoryOrderStore({
			idGen: new CountingIdGen("oi"),
			clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
		});
		return Promise.resolve({
			store,
			seedOrder: async (row) => {
				store.seedSummaryOrder(row);
			},
		});
	},
	{ dialect: "fake" },
);
