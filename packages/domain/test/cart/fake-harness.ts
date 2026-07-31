import type { CartDeps } from "@otta-sh/domain";
import {
	type CartStoreHarness,
	CountingIdGen,
	FixedClock,
	InMemoryCartStore,
	InMemoryInventoryStore,
} from "@otta-sh/domain/testing";

export interface FakeCartHarness extends CartStoreHarness {
	inventory: InMemoryInventoryStore;
	cartStore: InMemoryCartStore;
	clock: FixedClock;
}

/** Wire the IO-free cart + inventory fakes + a fake Clock into a cart harness. */
export function makeFakeCartHarness(): FakeCartHarness {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const inventory = new InMemoryInventoryStore({ idGen: new CountingIdGen("res"), clock });
	const cartStore = new InMemoryCartStore({
		idGen: new CountingIdGen("cart"),
		reservationState: (id) => {
			try {
				return inventory.reservationState(id);
			} catch {
				return undefined;
			}
		},
		releaseHold: (id) => {
			// Synchronous under the hood; the guarded expireHold flip already
			// verified `held`, so this cannot throw.
			void inventory.release(id);
		},
	});
	const deps: CartDeps = { cartStore, inventoryStore: inventory, clock };
	return {
		deps,
		inventory,
		cartStore,
		clock,
		async seedStock(sku, qty) {
			inventory.seed(sku, qty);
		},
		async onHand(sku) {
			return inventory.onHand(sku);
		},
		advance(ms) {
			clock.advance(ms);
		},
	};
}
