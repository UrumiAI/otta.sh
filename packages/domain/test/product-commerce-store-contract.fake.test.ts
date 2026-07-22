import {
	FixedClock,
	InMemoryProductCommerceStore,
	productCommerceStoreContract,
} from "@urumi/domain/testing";

// Phase 1 step 3: the reusable behavioral spec runs against its first
// adapter — the IO-free fake — proving the suite is real and the port shape
// is right before any DB. Every DB dialect (step 4) runs the *same* suite.
// Phase 2 (`listCommerceByIds`): the harness seeds a plain on-hand map
// standing in for the inventory table the real store's `inStock` join reads.
productCommerceStoreContract(
	async () => {
		const onHand = new Map<string, number>();
		const store = new InMemoryProductCommerceStore({
			clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
			inventoryOnHand: (sku) => onHand.get(sku) ?? 0,
		});
		return {
			store,
			async seedStock(sku, qty) {
				onHand.set(sku, qty);
			},
			async seedProduct(row) {
				store.seedProductRow(row);
			},
		};
	},
	{ dialect: "fake" },
);
