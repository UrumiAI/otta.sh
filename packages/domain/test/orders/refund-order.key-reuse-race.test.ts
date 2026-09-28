import { cents, currency as toCurrency } from "@otta-sh/domain";
import { idempotencyKey, orderId as toOrderId, productId, sku } from "@otta-sh/domain";
import { refundOrder } from "@otta-sh/domain";
import type { IdempotencyKey, PaymentMethod, RefundRecord } from "@otta-sh/domain";
import {
	CountingIdGen,
	FakePaymentGateway,
	FixedClock,
	InMemoryOrderStore,
} from "@otta-sh/domain/testing";
import { describe, expect, test } from "vitest";

const USD = toCurrency("USD");

// Issue #152: a reused idempotency key with different content must be rejected,
// not reported as a duplicate success. The contract suite covers the pre-write
// replay read; this covers the RACE window — a concurrent caller inserts under
// the key between our replay read and our own store write, so the store's
// `duplicate` outcome is the first place the mismatch can be seen.

/** A store whose replay read never sees the row — the deterministic stand-in for
 *  "the concurrent insert landed after we looked". */
class BlindReplayReadStore extends InMemoryOrderStore {
	override async getRefundByIdempotencyKey(_key: IdempotencyKey): Promise<RefundRecord | null> {
		return null;
	}
}

async function seedPaid(
	store: InMemoryOrderStore,
	id: string,
	gateway: PaymentMethod,
): Promise<ReturnType<typeof toOrderId>> {
	const oid = toOrderId(id);
	await store.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`seed-${id}`),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: gateway,
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
		gateway,
		providerRef: `pi_${id}`,
		amount: cents(1000),
		currency: USD,
		status: "succeeded",
	});
	return oid;
}

function makeStore(): BlindReplayReadStore {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	return new BlindReplayReadStore({ idGen: new CountingIdGen("oi"), clock });
}

describe("refundOrder — key reuse surfaced by the store's duplicate outcome (#152)", () => {
	test("gateway path: a reserve that finds the key held for a different amount is rejected before any provider call", async () => {
		const orderStore = makeStore();
		const id = await seedPaid(orderStore, "ord-race-gw", "stripe");
		const key = idempotencyKey("rf-race-gw");
		const gw = new FakePaymentGateway({ id: "stripe" });
		gw.setRefundResult({ ok: false, reason: "RETRYABLE" });
		await refundOrder({ orderStore }, gw, {
			orderId: id,
			amount: cents(400),
			currency: USD,
			refundedBy: "admin",
			idempotencyKey: key,
		});
		expect(gw.refundCalls).toHaveLength(1);

		const res = await refundOrder({ orderStore }, gw, {
			orderId: id,
			amount: cents(900),
			currency: USD,
			refundedBy: "admin",
			idempotencyKey: key,
		});
		expect(res).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
		expect(gw.refundCalls, "never issued for the mismatched reuse").toHaveLength(1);
	});

	test("manual path: a record that finds the key recorded for a different amount is rejected", async () => {
		const orderStore = makeStore();
		const id = await seedPaid(orderStore, "ord-race-manual", "x402");
		const key = idempotencyKey("rf-race-manual");
		const gw = new FakePaymentGateway({ id: "x402" });
		const first = await refundOrder({ orderStore }, gw, {
			orderId: id,
			amount: cents(300),
			currency: USD,
			refundedBy: "admin",
			idempotencyKey: key,
		});
		expect(first.ok && first.recorded).toBe(true);

		const res = await refundOrder({ orderStore }, gw, {
			orderId: id,
			amount: cents(700),
			currency: USD,
			refundedBy: "admin",
			idempotencyKey: key,
		});
		expect(res).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
	});

	test("a matching duplicate from the store is still the benign replay", async () => {
		const orderStore = makeStore();
		const id = await seedPaid(orderStore, "ord-race-same", "x402");
		const gw = new FakePaymentGateway({ id: "x402" });
		const cmd = {
			orderId: id,
			amount: cents(300),
			currency: USD,
			refundedBy: "admin",
			idempotencyKey: idempotencyKey("rf-race-same"),
		};
		await refundOrder({ orderStore }, gw, cmd);
		const res = await refundOrder({ orderStore }, gw, cmd);
		expect(res.ok && res.duplicate).toBe(true);
	});
});
