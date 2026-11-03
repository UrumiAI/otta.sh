/**
 * ADR-0044 §7: an offline order keeps its network key (`offlineClientKey`, the
 * HMAC the per-network cap counts) only while it is open. Leaving the open states
 * — paid, delivered, cancelled — drops it from the stored document in the same
 * write, so a closed order keeps no network trace. Read off the raw document,
 * because no port exposes the key.
 */
import { cents, currency, idempotencyKey, orderId, productId, sku } from "@urumi.ai/otta-domain";
import { expect, test } from "vitest";
import { collectionOf, ORDERS_COLLECTION, type OrderDoc } from "../src/index.js";
import { PAYMENT_DECLINE_LAYOUT } from "./coupon-collections.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { makePaymentDeclineHarness } from "./payment-decline-harness.js";

const USD = currency("USD");

describeEachDialect("offline client key lifetime", (ctx) => {
	const bound = ctx.useStorage(PAYMENT_DECLINE_LAYOUT);

	for (const close of ["paid", "cancelled"] as const) {
		test(`the key is stored while the order is open and dropped once it is ${close} [${ctx.dialect}]`, async () => {
			const h = makePaymentDeclineHarness(bound.storage);
			const store = h.settleDeps.orderStore;
			const oid = orderId(`ord-key-${close}`);
			await store.createFromCart({
				orderId: oid,
				cartId: null,
				currency: USD,
				idempotencyKey: idempotencyKey(`key-${close}`),
				holdExpiresAt: "2026-07-10T00:15:00.000Z",
				buyerRef: "buyer@example.com",
				paymentMethod: "cod",
				offlineClientKey: "hmac-of-network",
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
				idempotencyKey: idempotencyKey(`place-${close}`),
				enqueueEmail: false,
			});
			const docs = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
			expect((await docs.get(oid))?.offlineClientKey).toBe("hmac-of-network");
			expect(
				await store.countOpenOfflineOrders({
					buyerRef: "x@example.com",
					clientKey: "hmac-of-network",
				}),
			).toEqual({ byBuyer: 0, byClient: 1 });

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
});
