import { idempotencyKey } from "@urumi/domain";
import {
	CountingIdGen,
	FixedClock,
	InMemoryInventoryStore,
	type InventoryStoreHarness,
	inventoryStoreContract,
} from "@urumi/domain/testing";

// Step 0.3: the reusable behavioral spec runs against its first adapter — the
// IO-free fake — proving the suite is real and the port shape is right before
// any DB. Every DB dialect (step 0.4) runs the *same* suite.
inventoryStoreContract(
	async (): Promise<InventoryStoreHarness> => {
		const store = new InMemoryInventoryStore({
			idGen: new CountingIdGen("res"),
			clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
		});
		return {
			store,
			async seed(sku, qty) {
				store.seed(sku, qty);
			},
			async onHand(sku) {
				return store.onHand(sku);
			},
			async abandonPending(sku, qty, key) {
				store.abandonPending(sku, qty, idempotencyKey(key));
			},
		} as InventoryStoreHarness & {
			abandonPending(sku: string, qty: number, key: string): Promise<void>;
		};
	},
	{ dialect: "fake" },
);
