import {
	FixedClock,
	InMemoryProductCommerceStore,
	productCommerceStoreContract,
} from "@otta-sh/domain/testing";

// Phase 1 step 3: the reusable behavioral spec runs against its first
// adapter — the IO-free fake — proving the suite is real and the port shape
// is right before any DB. Every DB dialect (step 4) runs the *same* suite.
// Phase 2 (`listCommerceByIds`) + the `listProducts.onHand` projection: the
// harness seeds a plain on-hand map standing in for the `inventory` table the
// real store LEFT JOINs. An ABSENT key resolves to `null` — the join miss —
// never 0, so the fake agrees with the SQL adapters that "no inventory row"
// and "stocked at zero" are different facts.
productCommerceStoreContract(
	async () => {
		const onHand = new Map<string, number>();
		const store = new InMemoryProductCommerceStore({
			clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
			inventoryOnHand: (sku) => onHand.get(sku) ?? null,
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
