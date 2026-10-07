/**
 * The domain's `cancelWithRefundContract` against `EmdashOrderStore` and
 * `EmdashInventoryStore`, on both Node dialects (QA T1-4).
 *
 * What it proves through the document model: a cancellation's refund rides the same
 * reserve-before-issue ledger as any refund but never flips the order `→ refunded`;
 * the restock is the inventory ledger's own exactly-once `restock`, so a retry after
 * a crash between the refund and the cancel moves no second unit; and the cancel
 * flip records the refund and the restock on the envelope it already guards.
 *
 * Plus the document store's own half of issue #364: a restock still owed after the
 * flip is in the `holdsPendingAt` index (so the hold-intent sweep leg finds it), and
 * closing it takes the order out again.
 */
import {
	cancelOrderWithRefund,
	cents,
	currency,
	finishCancellationRestock,
	idempotencyKey,
	orderId as toOrderId,
	productId,
	sku,
	type InventoryStore,
} from "@otta-sh/domain";
import { cancelWithRefundContract, FakePaymentGateway } from "@otta-sh/domain/testing";
import { expect, test } from "vitest";
import { collectionOf, ORDERS_COLLECTION, type OrderDoc } from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness } from "./order-harness.js";

describeEachDialect("EmdashOrderStore cancel with refund", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	cancelWithRefundContract(
		() => {
			const h = makeOrderHarness(bound.storage, { countingIds: true });
			return {
				orderStore: h.store,
				inventoryStore: h.inventory,
				clock: h.clock,
				// A checkout hold is stamped by the cart before it can be adopted.
				stampHold: (reservationId, expiresAt) =>
					h.inventory.stampHoldDeadline(reservationId, expiresAt),
			};
		},
		{ dialect: ctx.dialect },
	);
});

describeEachDialect("EmdashOrderStore cancel with refund: a pending restock is indexed", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);

	test("a restock owed after the flip is in holdsPendingAt until it is finished", async () => {
		const h = makeOrderHarness(bound.storage, { countingIds: true });
		const usd = currency("USD");
		const id = toOrderId("cxl-indexed");
		await h.inventory.seedOnHand("SKU-cxl-indexed", 10);
		await h.store.createFromCart({
			orderId: id,
			cartId: null,
			currency: usd,
			idempotencyKey: idempotencyKey("seed-cxl-indexed"),
			holdExpiresAt: "2099-01-01T00:00:00.000Z",
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
			lines: [
				{
					productId: productId("p-cxl"),
					sku: sku("SKU-cxl-indexed"),
					title: "Widget",
					unitPrice: cents(500),
					currency: usd,
					quantity: 2,
					fulfillmentKind: "physical",
					reservationId: null,
				},
			],
			totals: { subtotal: cents(1000), total: cents(1000), currency: usd },
		});
		await h.store.markPaid(id);
		await h.store.recordPayment({
			orderId: id,
			gateway: "stripe",
			providerRef: "pi_cxl_indexed",
			amount: cents(1000),
			currency: usd,
			status: "succeeded",
		});
		// Settle's commit intent closes on the way to paid; nothing else is owed.
		await h.store.completeHoldAdoption(id);
		await h.store.completeHoldCommit(id);
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		expect((await orders.get(id))?.holdsPendingAt).toBeNull();

		// The restock throws once, after the flip.
		let failed = false;
		const flaky = new Proxy(h.inventory as InventoryStore, {
			get(target, prop, receiver) {
				if (prop === "restock" && !failed) {
					return async () => {
						failed = true;
						throw new Error("simulated restock failure");
					};
				}
				const value: unknown = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? (value as Function).bind(target) : value;
			},
		});
		const res = await cancelOrderWithRefund(
			{ orderStore: h.store, inventoryStore: flaky },
			new FakePaymentGateway({ id: "stripe" }),
			{
				orderId: id,
				reason: "customer_request",
				cancelledBy: "admin@shop",
				restock: true,
				idempotencyKey: idempotencyKey("cxl:indexed"),
			},
		);
		expect(res).toMatchObject({ ok: true, cancelled: true, restockPending: true });
		const owed = await orders.get(id);
		expect(owed?.cancellation?.restockPending).toMatchObject({ idempotencyKey: "cxl:indexed" });
		expect(owed?.holdsPendingAt).toBe(owed?.cancellation?.cancelledAt);
		expect(await h.inventory.getOnHand("SKU-cxl-indexed")).toBe(10);

		expect(
			await finishCancellationRestock({ orderStore: h.store, inventoryStore: h.inventory }, id),
		).toMatchObject({ finished: true, restockedUnits: 2 });
		const done = await orders.get(id);
		expect(done?.cancellation?.restockPending ?? null).toBeNull();
		expect(done?.cancellation?.restocked).toBe(true);
		expect(done?.holdsPendingAt).toBeNull();
		expect(await h.inventory.getOnHand("SKU-cxl-indexed")).toBe(12);
	});
});
