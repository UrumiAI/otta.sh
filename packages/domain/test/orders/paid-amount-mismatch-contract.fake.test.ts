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
	paidAmountMismatchContract,
} from "@urumi.ai/otta-domain/testing";

// Issue #35 — a stray wrong-amount success on an already-paid order stays in the
// forensic trail — against the in-memory fakes, before the document store dialects.
paidAmountMismatchContract(
	() => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const orderStore = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
		const inventoryStore = new InMemoryInventoryStore({ idGen: new CountingIdGen("res"), clock });
		const couponStore = new InMemoryCouponStore({ idGen: new CountingIdGen("red"), clock });
		const paymentEventStore = new InMemoryPaymentEventStore();
		return {
			settleDeps: {
				orderStore,
				inventoryStore,
				entitlementStore: new InMemoryEntitlementStore({ idGen: new CountingIdGen("ent"), clock }),
				paymentEventStore,
				clock,
				logger: new RecordingLogger(),
			},
			expireDeps: { orderStore, inventoryStore, couponStore, clock, logger: new RecordingLogger() },
			async holdForCheckout(sku, qty, key) {
				const reserved = await inventoryStore.reserve(sku, qty, idempotencyKey(key));
				if (!reserved.ok) throw new Error(`reserve failed: ${reserved.reason}`);
				return reserved.reservationId;
			},
			advanceClock: (ms) => clock.advance(ms),
			anomalies: async () => paymentEventStore.anomalies(),
		};
	},
	{ dialect: "fake" },
);
