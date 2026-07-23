import { cents, currency as toCurrency } from "@urumi/domain";
import { idempotencyKey, orderId as toOrderId, productId, sku } from "@urumi/domain";
import { refundOrder } from "@urumi/domain";
import type { FinalizeRefundStoreResult } from "@urumi/domain";
import {
	CountingIdGen,
	FakePaymentGateway,
	FixedClock,
	InMemoryOrderStore,
	InMemoryPaymentEventStore,
} from "@urumi/domain/testing";
import { describe, expect, test } from "vitest";

const USD = toCurrency("USD");

// ADR-0008, reserve-before-issue: "issued but unrecorded" is impossible by
// construction (issuance strictly follows a committed reservation, and finalize
// only updates that existing row). This suite drives the LOUD RESIDUAL guard
// anyway — a store whose `finalizeRefund` reports `found:false` after the gateway
// confirmed issuance — to prove the money is NEVER silently dropped: an anomaly
// carrying the provider refundRef is recorded, the order is flagged for
// reconciliation, and a DISTINCT reason surfaces (never a clean rejection).

/** An OrderStore that reserves + issues normally but whose finalize LOSES the
 *  reserved row — the only way to reach the impossible residual in a test. */
class FinalizeLosesRowStore extends InMemoryOrderStore {
	override async finalizeRefund(): Promise<FinalizeRefundStoreResult> {
		return { found: false, refund: null, fullyRefunded: false, order: null };
	}
}

async function seedPaid(
	store: InMemoryOrderStore,
	id: string,
): Promise<ReturnType<typeof toOrderId>> {
	const oid = toOrderId(id);
	await store.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`seed-${id}`),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId("p1"),
				sku: sku("SKU-1"),
				title: "Widget",
				unitPrice: cents(1000),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(1000), total: cents(1000), currency: USD },
	});
	await store.markPaid(oid);
	await store.recordPayment({
		orderId: oid,
		gateway: "stripe",
		providerRef: `pi_${id}`,
		amount: cents(1000),
		currency: USD,
		status: "succeeded",
	});
	return oid;
}

describe("refundOrder — issued-but-unrecorded residual (ADR-0008)", () => {
	test("records a REFUND_UNRECORDED anomaly with the refundRef, flags reconciliation, returns the distinct reason", async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const orderStore = new FinalizeLosesRowStore({ idGen: new CountingIdGen("oi"), clock });
		const paymentEventStore = new InMemoryPaymentEventStore();
		const id = await seedPaid(orderStore, "ord-residual");
		const gw = new FakePaymentGateway({ id: "stripe" });

		const res = await refundOrder({ orderStore, paymentEventStore, clock }, gw, {
			orderId: id,
			amount: cents(1000),
			currency: USD,
			refundedBy: "admin",
			idempotencyKey: idempotencyKey("rf-residual"),
		});

		// The DISTINCT reason — never confusable with a clean pre-issuance rejection.
		expect(res).toEqual({ ok: false, reason: "REFUND_ISSUED_UNRECORDED" });
		// The gateway DID issue (money moved) — proven by the recorded call.
		expect(gw.refundCalls).toHaveLength(1);
		// A loud anomaly carrying the provider refundRef — the money is on the record.
		const anomalies = paymentEventStore.anomalies();
		expect(anomalies).toHaveLength(1);
		expect(anomalies[0]?.kind).toBe("REFUND_UNRECORDED");
		expect(anomalies[0]?.detail).toContain(`re_${idempotencyKey("rf-residual")}`);
		// And the order is flagged for manual reconciliation.
		expect((await orderStore.getById(id))?.reconciliationFlag).not.toBeNull();
	});

	test("without a paymentEventStore wired, it STILL flags reconciliation and returns the distinct reason (never a silent drop)", async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const orderStore = new FinalizeLosesRowStore({ idGen: new CountingIdGen("oi"), clock });
		const id = await seedPaid(orderStore, "ord-residual2");
		const gw = new FakePaymentGateway({ id: "stripe" });

		const res = await refundOrder({ orderStore }, gw, {
			orderId: id,
			amount: cents(1000),
			currency: USD,
			refundedBy: "admin",
			idempotencyKey: idempotencyKey("rf-residual2"),
		});

		expect(res).toEqual({ ok: false, reason: "REFUND_ISSUED_UNRECORDED" });
		expect((await orderStore.getById(id))?.reconciliationFlag).not.toBeNull();
	});
});
