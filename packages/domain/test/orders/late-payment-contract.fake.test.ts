import { idempotencyKey } from "@otta-sh/domain";
import {
	CountingIdGen,
	FixedClock,
	InMemoryCouponStore,
	InMemoryEntitlementStore,
	InMemoryInventoryStore,
	InMemoryOrderStore,
	InMemoryPaymentEventStore,
	latePaymentContract,
} from "@otta-sh/domain/testing";

// The late-payment cure (auto-refund once, flagged honestly, buyer told once)
// against the in-memory fakes — the first adapter family to pass it, before the
// document store on sqlite, Postgres and D1.
latePaymentContract(
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
			async seedOrderWithoutAudit(row) {
				orderStore.seedSummaryOrder(row);
			},
			async holdForCheckout(sku, qty, key) {
				const reserved = await inventoryStore.reserve(sku, qty, idempotencyKey(key));
				if (!reserved.ok) throw new Error(`reserve failed: ${reserved.reason}`);
				return reserved.reservationId;
			},
		};
	},
	{ dialect: "fake" },
);
