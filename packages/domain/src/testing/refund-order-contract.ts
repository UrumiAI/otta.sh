import { describe, expect, test } from "vitest";
import { cents, currency as toCurrency } from "../money/cents.js";
import { idempotencyKey, orderId as toOrderId, productId, sku } from "../money/ids.js";
import type { OrderId } from "../money/ids.js";
import type { PaymentMethod } from "../orders/model.js";
import { refundOrder } from "../orders/refund-order.js";
import type { OrderStore } from "../ports/order-store.js";
import { FakePaymentGateway } from "./fake-payment-gateway.js";

const USD = toCurrency("USD");

/** A store + a way to seed a PAID order with a captured payment, so the same
 *  refund/ledger spec runs against the in-memory fake, sqlite, and pg. */
export interface RefundOrderHarness {
	orderStore: OrderStore;
	/**
	 * Seed a `paid` order carrying ONE captured (`succeeded`) payment. `totalCents`
	 * is the frozen `order_totals.total`; `capturedCents` (defaults to `totalCents`)
	 * is the recorded payment amount — set it LOWER to model a short capture (the
	 * ceiling then binds at captured). `gateway` (default `stripe`) is the captured
	 * payment's gateway. Returns the order id.
	 */
	seedPaidOrder(input: {
		id: string;
		totalCents: number;
		capturedCents?: number;
		gateway?: PaymentMethod;
	}): Promise<OrderId>;
}

export interface RefundOrderContractOptions {
	dialect: string;
}

/** Build a `seedPaidOrder` over any `OrderStore` — adapter-agnostic (createFromCart
 *  → markPaid → recordPayment), so the fake/sqlite/pg all seed identically. */
export function buildRefundSeed(store: OrderStore): RefundOrderHarness["seedPaidOrder"] {
	return async ({ id, totalCents, capturedCents, gateway = "stripe" }) => {
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
					unitPrice: cents(totalCents),
					currency: USD,
					quantity: 1,
					// Digital ⇒ no reservation needed, so no inventory store to wire.
					fulfillmentKind: "digital",
					reservationId: null,
				},
			],
			totals: { subtotal: cents(totalCents), total: cents(totalCents), currency: USD },
		});
		await store.markPaid(oid);
		await store.recordPayment({
			orderId: oid,
			gateway,
			providerRef: `pi_${id}`,
			amount: cents(capturedCents ?? totalCents),
			currency: USD,
			status: "succeeded",
		});
		return oid;
	};
}

/**
 * The shared refunds spec (ADR-0008) — the ledger ceiling, the gateway/manual
 * split, idempotent replay, and the full-refund `→ refunded` flip. Run against
 * the in-memory fake first, then sqlite + pg. The MONEY-MOVEMENT gateway leg is a
 * `FakePaymentGateway`; the REAL Stripe transport (pre-flight + refunds.create) is
 * proven separately in `@urumi/payments-stripe`. Postgres additionally runs the
 * concurrency races (a separate file — sqlite serializes writes, so it can't race).
 */
export function refundOrderContract(
	makeHarness: () => Promise<RefundOrderHarness> | RefundOrderHarness,
	opts: RefundOrderContractOptions,
): void {
	describe(`refundOrderContract [${opts.dialect}]`, () => {
		test("a full gateway refund records the ledger row and flips the order to refunded", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-full", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const res = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(1000),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-full"),
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.recorded).toBe(true);
			expect(res.fullyRefunded).toBe(true);
			expect(res.refund.kind).toBe("gateway");
			expect(res.refund.refundRef).not.toBeNull();
			expect(res.order.state).toBe("refunded");
			expect(gw.refundCalls).toHaveLength(1);
			// The flip rode the #flipAndEnqueue choke point — a → refunded state-change
			// event with the refunder as actor.
			const refundedEvents = (await h.orderStore.listEventsForOrder(id)).filter(
				(e) => e.toState === "refunded",
			);
			expect(refundedEvents).toHaveLength(1);
			expect(refundedEvents[0]?.actor).toBe("admin");
			const ledger = await h.orderStore.listRefunds(id);
			expect(ledger).toHaveLength(1);
			expect(ledger[0]?.amount).toBe(1000);
		});

		test("a partial refund records the row and does NOT transition (order stays paid)", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-partial", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const res = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(300),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-partial"),
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.recorded).toBe(true);
			expect(res.fullyRefunded).toBe(false);
			expect(res.order.state).toBe("paid");
			expect(await h.orderStore.listRefunds(id)).toHaveLength(1);
		});

		test("repeated partials summing to the ceiling flip the order to refunded on the last one", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-sum", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const first = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(600),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-a"),
			});
			expect(first.ok && first.fullyRefunded).toBe(false);
			const second = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(400),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-b"),
			});
			expect(second.ok).toBe(true);
			if (!second.ok) return;
			expect(second.fullyRefunded).toBe(true);
			expect(second.order.state).toBe("refunded");
			const ledger = await h.orderStore.listRefunds(id);
			expect(ledger.reduce((s, r) => s + r.amount, 0)).toBe(1000);
		});

		test("an over-refund past the frozen total is rejected (REFUND_EXCEEDS_TOTAL); nothing recorded", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-over", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const res = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(1001),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-over"),
			});
			expect(res).toEqual({ ok: false, reason: "REFUND_EXCEEDS_TOTAL" });
			expect(await h.orderStore.listRefunds(id)).toHaveLength(0);
		});

		test("a short capture binds the ceiling at captured (REFUND_EXCEEDS_CAPTURED past it)", async () => {
			const h = await makeHarness();
			// Frozen total 1000, but only 700 actually captured (a settle anomaly).
			const id = await h.seedPaidOrder({ id: "ord-short", totalCents: 1000, capturedCents: 700 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			// Up to captured is fine…
			const ok = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(700),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-short-ok"),
			});
			expect(ok.ok && ok.fullyRefunded).toBe(true);
			expect(ok.ok && ok.order.state).toBe("refunded");
			// …a fresh order can't be refunded past captured even though total is higher.
			const id2 = await h.seedPaidOrder({ id: "ord-short2", totalCents: 1000, capturedCents: 700 });
			const over = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id2,
				amount: cents(701),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-short-over"),
			});
			expect(over).toEqual({ ok: false, reason: "REFUND_EXCEEDS_CAPTURED" });
		});

		test("an idempotent replay records once and never calls the gateway twice", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-idem", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const cmd = {
				orderId: id,
				amount: cents(500),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-idem"),
			};
			const first = await refundOrder({ orderStore: h.orderStore }, gw, cmd);
			const replay = await refundOrder({ orderStore: h.orderStore }, gw, cmd);
			expect(first.ok && first.recorded).toBe(true);
			expect(replay.ok).toBe(true);
			if (replay.ok) {
				expect(replay.recorded).toBe(false);
				expect(replay.duplicate).toBe(true);
			}
			expect(gw.refundCalls).toHaveLength(1); // NO second provider call
			expect(await h.orderStore.listRefunds(id)).toHaveLength(1);
		});

		test("an x402 (refundable:false) order records a MANUAL refund with no gateway call", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-x402", totalCents: 1000, gateway: "x402" });
			const gw = new FakePaymentGateway({ id: "x402" }); // refundable:false by default
			const res = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(1000),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-x402"),
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.refund.kind).toBe("manual");
			expect(res.refund.refundRef).toBeNull();
			expect(res.fullyRefunded).toBe(true);
			expect(res.order.state).toBe("refunded");
			expect(gw.refundCalls).toHaveLength(0); // never called — capability, not discovery
		});

		test("a gateway PROVIDER_ALREADY_REFUNDED fails closed — nothing recorded", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-preflight", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			gw.setRefundResult({ ok: false, reason: "PROVIDER_ALREADY_REFUNDED" });
			const res = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(500),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-preflight"),
			});
			expect(res).toEqual({ ok: false, reason: "PROVIDER_ALREADY_REFUNDED" });
			expect(await h.orderStore.listRefunds(id)).toHaveLength(0);
			expect((await h.orderStore.getById(id))?.state).toBe("paid");
		});

		test("refunding an unpaid order (no captured payment) is rejected, ceiling 0", async () => {
			const h = await makeHarness();
			// Seed a paid order but with ZERO captured (no succeeded payment).
			const oid = toOrderId("ord-unpaid");
			await h.orderStore.createFromCart({
				orderId: oid,
				cartId: null,
				currency: USD,
				idempotencyKey: idempotencyKey("seed-unpaid"),
				holdExpiresAt: "2026-07-10T00:15:00.000Z",
				buyerRef: "b@example.com",
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
			const gw = new FakePaymentGateway({ id: "stripe" });
			const res = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: oid,
				amount: cents(100),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-unpaid"),
			});
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.reason).toBe("REFUND_EXCEEDS_CAPTURED");
			expect(await h.orderStore.listRefunds(oid)).toHaveLength(0);
			expect(gw.refundCalls).toHaveLength(0);
		});

		test("a currency mismatch and an empty refundedBy are rejected", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-guard", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const wrongCurrency = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(100),
				currency: toCurrency("EUR"),
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-cur"),
			});
			expect(wrongCurrency).toEqual({ ok: false, reason: "CURRENCY_MISMATCH" });
			const noActor = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(100),
				currency: USD,
				refundedBy: "   ",
				idempotencyKey: idempotencyKey("rf-actor"),
			});
			expect(noActor).toEqual({ ok: false, reason: "EMPTY_REFUNDED_BY" });
		});
	});
}
