import { idempotencyKey } from "@urumi.ai/otta-domain";
import {
	CountingIdGen,
	FixedClock,
	InMemoryCouponStore,
	InMemoryEntitlementStore,
	InMemoryInventoryStore,
	InMemoryOrderStore,
	InMemoryPaymentEventStore,
	RecordingLogger,
	offlinePaymentContract,
} from "@urumi.ai/otta-domain/testing";

// The offline (cash-on-delivery) lifecycle, ADR-0042, against the in-memory fakes.
offlinePaymentContract(
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
				logger: new RecordingLogger(),
			},
			expireDeps: { orderStore, inventoryStore, couponStore, clock, logger: new RecordingLogger() },
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
