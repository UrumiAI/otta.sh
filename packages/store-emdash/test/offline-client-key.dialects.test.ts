/**
 * ADR-0044 §7: an offline order keeps its network key (`offlineClientKey`, the
 * HMAC the per-network cap counts) only while it is `awaiting_payment` — the one
 * state the cap counts (#678). Shipping it unpaid, paying it or cancelling it drops
 * the key from the stored document in the same write, so a shipped or closed order
 * keeps no network trace. Read off the raw document, because no port exposes the key.
 */
import {
	cents,
	currency,
	idempotencyKey,
	type OrderId,
	type OrderStore,
	orderId,
	productId,
	sku,
} from "@urumi.ai/otta-domain";
import { expect, test } from "vitest";
import { collectionOf, ORDERS_COLLECTION, type OrderDoc } from "../src/index.js";
import { PAYMENT_DECLINE_LAYOUT } from "./coupon-collections.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { makePaymentDeclineHarness } from "./payment-decline-harness.js";

const USD = currency("USD");
const NETWORK = "hmac-of-network";

/** A COD order placed under `NETWORK`, moved to `awaiting_payment` as checkout does. */
async function placeCod(store: OrderStore, tag: string): Promise<OrderId> {
	const oid = orderId(`ord-key-${tag}`);
	await store.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`key-${tag}`),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "cod",
		offlineClientKey: NETWORK,
		lines: [
			{
				productId: productId("p1"),
				sku: sku("DIG-1"),
				title: "Widget",
				unitPrice: cents(500),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(500), total: cents(500), currency: USD },
	});
	await store.transition({
		orderId: oid,
		fromState: "pending",
		toState: "awaiting_payment",
		idempotencyKey: idempotencyKey(`place-${tag}`),
		enqueueEmail: false,
	});
	return oid;
}

/** Record a shipment for an unpaid COD order: `awaiting_payment → shipped_awaiting_payment`. */
async function shipUnpaid(store: OrderStore, oid: OrderId): Promise<void> {
	const { recorded } = await store.recordFulfillment({
		orderId: oid,
		fromState: "awaiting_payment",
		toState: "shipped_awaiting_payment",
		carrier: "Courier",
		trackingNumber: "TRK-1",
		trackingUrl: null,
		shippedAt: null,
		recordedBy: "Ops",
		idempotencyKey: idempotencyKey(`ship-${oid}`),
		enqueueEmail: false,
	});
	expect(recorded).toBe(true);
}

const countNetwork = (store: OrderStore) =>
	store.countOpenOfflineOrders({ buyerRef: "x@example.com", clientKey: NETWORK });

describeEachDialect("offline client key lifetime", (ctx) => {
	const bound = ctx.useStorage(PAYMENT_DECLINE_LAYOUT);

	for (const close of ["paid", "cancelled"] as const) {
		test(`the key is stored while the order is open and dropped once it is ${close} [${ctx.dialect}]`, async () => {
			const h = makePaymentDeclineHarness(bound.storage);
			const store = h.settleDeps.orderStore;
			const oid = await placeCod(store, close);
			const docs = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
			expect((await docs.get(oid))?.offlineClientKey).toBe(NETWORK);
			expect(await countNetwork(store)).toEqual({ byBuyer: 0, byClient: 1 });

			if (close === "paid") {
				await store.markPaid(oid, "offline:cod:x", {
					fromState: "awaiting_payment",
					toState: "paid",
					actor: "Ops",
				});
			} else {
				await store.cancelOrder({
					orderId: oid,
					fromState: "awaiting_payment",
					reason: "customer_request",
					detail: null,
					cancelledBy: "Ops",
					idempotencyKey: idempotencyKey(`cancel-${close}`),
					enqueueEmail: false,
				});
			}
			const doc = await docs.get(oid);
			expect(doc?.state).toBe(close);
			expect(doc?.offlineClientKey).toBeUndefined();
		});
	}

	test(`shipping it unpaid drops the key in the same write, and the network count with it [${ctx.dialect}]`, async () => {
		const store = makePaymentDeclineHarness(bound.storage).settleDeps.orderStore;
		const oid = await placeCod(store, "shipped");
		await shipUnpaid(store, oid);
		const doc = await collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION).get(oid);
		expect(doc?.state).toBe("shipped_awaiting_payment");
		expect(doc?.offlineClientKey).toBeUndefined();
		expect(await countNetwork(store)).toEqual({ byBuyer: 0, byClient: 0 });
	});

	/**
	 * Rollout: an order shipped before the key was dropped on shipping still carries
	 * it. It counts for its network exactly as it did before #678 — never more — until
	 * it is paid or cancelled, which drops the key. No stored document is rewritten.
	 */
	test(`a shipped order that still carries its key, written before the upgrade, counts as it did before #678 [${ctx.dialect}]`, async () => {
		const store = makePaymentDeclineHarness(bound.storage).settleDeps.orderStore;
		const oid = await placeCod(store, "legacy");
		await shipUnpaid(store, oid);
		const docs = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		const shipped = await docs.get(oid);
		if (shipped === null) throw new Error("the shipped order is missing");
		await docs.put(oid, { ...shipped, offlineClientKey: NETWORK });
		expect(await countNetwork(store)).toEqual({ byBuyer: 0, byClient: 1 });
		await store.markPaid(oid, "offline:cod:legacy", {
			fromState: "shipped_awaiting_payment",
			toState: "delivered",
			actor: "Ops",
		});
		expect((await docs.get(oid))?.offlineClientKey).toBeUndefined();
		expect(await countNetwork(store)).toEqual({ byBuyer: 0, byClient: 0 });
	});
});
