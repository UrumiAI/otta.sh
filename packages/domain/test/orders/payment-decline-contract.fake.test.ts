import { idempotencyKey } from "@otta-sh/domain";
import {
	CountingIdGen,
	FixedClock,
	InMemoryCouponStore,
	InMemoryEntitlementStore,
	InMemoryInventoryStore,
	InMemoryOrderStore,
	InMemoryPaymentEventStore,
	paymentDeclineContract,
} from "@otta-sh/domain/testing";

// The decline spec (ADR-0022) against the in-memory fakes — the first adapter
// family to pass it, before the document store on sqlite, Postgres and D1.
paymentDeclineContract(
	() => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const orderStore = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
		const inventoryStore = new InMemoryInventoryStore({ idGen: new CountingIdGen("res"), clock });
		const couponStore = new InMemoryCouponStore({ idGen: new CountingIdGen("red"), clock });
		return {
			settleDeps: {
				orderStore,
				inventoryStore,
				entitlementStore: new InMemoryEntitlementStore({ idGen: new CountingIdGen("ent"), clock }),
				paymentEventStore: new InMemoryPaymentEventStore(),
				clock,
			},
			expireDeps: { orderStore, inventoryStore, couponStore, clock },
			async holdForCheckout(sku, qty, key) {
				// The fake's `adopt` accepts an unstamped hold, so a bare reserve is it.
				const reserved = await inventoryStore.reserve(sku, qty, idempotencyKey(key));
				if (!reserved.ok) throw new Error(`reserve failed: ${reserved.reason}`);
				return reserved.reservationId;
			},
		};
	},
	{ dialect: "fake" },
);
