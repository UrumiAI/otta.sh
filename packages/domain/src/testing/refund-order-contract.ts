import { describe, expect, test } from "vitest";
import { cents, currency as toCurrency } from "../money/cents.js";
import { idempotencyKey, orderId as toOrderId, productId, sku } from "../money/ids.js";
import type { OrderId } from "../money/ids.js";
import type { PaymentMethod } from "../orders/model.js";
import { refundOrder, sumRefunds } from "../orders/refund-order.js";
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

		test("a gateway PROVIDER_ALREADY_REFUNDED fails closed — reservation voided, capacity released", async () => {
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
			// Reserve-before-issue: the reservation was inserted then VOIDED (nothing
			// issued). It stays as an audit row but releases its ceiling capacity — the
			// ACTIVE Σ is 0 and the order never flipped.
			const ledger = await h.orderStore.listRefunds(id);
			expect(ledger.every((r) => r.status === "voided")).toBe(true);
			expect(sumRefunds(ledger), "voided rows release capacity").toBe(0);
			expect((await h.orderStore.getById(id))?.state).toBe("paid");
			// Capacity released ⇒ a FRESH full refund (distinct key) now succeeds.
			const retry = await refundOrder(
				{ orderStore: h.orderStore },
				new FakePaymentGateway({ id: "stripe" }),
				{
					orderId: id,
					amount: cents(1000),
					currency: USD,
					refundedBy: "admin",
					idempotencyKey: idempotencyKey("rf-preflight-retry"),
				},
			);
			expect(retry.ok && retry.fullyRefunded).toBe(true);
		});

		test("a terminal gateway rejection voids the reservation; an ambiguous timeout HOLDS it (capacity kept)", async () => {
			const h = await makeHarness();
			// TERMINAL → voided (capacity released).
			const idT = await h.seedPaidOrder({ id: "ord-terminal", totalCents: 1000 });
			const gwT = new FakePaymentGateway({ id: "stripe" });
			gwT.setRefundResult({ ok: false, reason: "TERMINAL" });
			const term = await refundOrder({ orderStore: h.orderStore }, gwT, {
				orderId: idT,
				amount: cents(400),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-terminal"),
			});
			expect(term).toEqual({ ok: false, reason: "GATEWAY_TERMINAL" });
			expect(sumRefunds(await h.orderStore.listRefunds(idT))).toBe(0); // released

			// UNVERIFIED (ambiguous timeout) → the row is HELD (unverified), keeps its
			// ceiling capacity (the safe direction), and does NOT flip the order.
			const idU = await h.seedPaidOrder({ id: "ord-unverified", totalCents: 1000 });
			const gwU = new FakePaymentGateway({ id: "stripe" });
			gwU.setRefundResult({ ok: false, reason: "UNVERIFIED" });
			const unver = await refundOrder({ orderStore: h.orderStore }, gwU, {
				orderId: idU,
				amount: cents(1000),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-unverified"),
			});
			expect(unver).toEqual({ ok: false, reason: "GATEWAY_UNVERIFIED" });
			const heldLedger = await h.orderStore.listRefunds(idU);
			expect(heldLedger).toHaveLength(1);
			expect(heldLedger[0]?.status).toBe("unverified");
			expect(sumRefunds(heldLedger), "unverified HOLDS capacity").toBe(1000);
			expect((await h.orderStore.getById(idU))?.state).toBe("paid"); // never flipped

			// The held capacity BLOCKS a second full refund (distinct key) — the ceiling
			// is already consumed by the unverified row until a human re-checks.
			const blocked = await refundOrder(
				{ orderStore: h.orderStore },
				new FakePaymentGateway({ id: "stripe" }),
				{
					orderId: idU,
					amount: cents(1000),
					currency: USD,
					refundedBy: "admin",
					idempotencyKey: idempotencyKey("rf-unverified-2"),
				},
			);
			expect(blocked).toEqual({ ok: false, reason: "REFUND_EXCEEDS_TOTAL" });
			// A same-key replay of the unverified refund re-surfaces GATEWAY_UNVERIFIED
			// (re-check the provider; NEVER a blind re-issue).
			const replay = await refundOrder({ orderStore: h.orderStore }, gwU, {
				orderId: idU,
				amount: cents(1000),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-unverified"),
			});
			expect(replay).toEqual({ ok: false, reason: "GATEWAY_UNVERIFIED" });
		});

		test("a transient RETRYABLE keeps the reservation so a same-key retry resumes and finalizes it", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-retry", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			gw.setRefundResult({ ok: false, reason: "RETRYABLE" });
			const first = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(1000),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-retry"),
			});
			expect(first).toEqual({ ok: false, reason: "GATEWAY_RETRYABLE" });
			// The reservation is KEPT (still holding capacity), unflipped.
			const held = await h.orderStore.listRefunds(id);
			expect(held).toHaveLength(1);
			expect(held[0]?.status).toBe("reserved");
			expect((await h.orderStore.getById(id))?.state).toBe("paid");
			// Same key retry, gateway now succeeds → RESUMES the existing reservation
			// (no second reserved row) and finalizes it, flipping → refunded.
			gw.setRefundResult({ ok: true, refundRef: "re_resumed", amount: cents(1000), currency: USD });
			const resumed = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(1000),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-retry"),
			});
			expect(resumed.ok && resumed.fullyRefunded).toBe(true);
			const finalLedger = await h.orderStore.listRefunds(id);
			expect(finalLedger, "still ONE row — the resumed reservation").toHaveLength(1);
			expect(finalLedger[0]?.status).toBe("recorded");
			expect(finalLedger[0]?.refundRef).toBe("re_resumed");
			expect((await h.orderStore.getById(id))?.state).toBe("refunded");
		});

		test("refunding an unpaid order (no captured payment) is rejected before reserving", async () => {
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
			// A refundable gateway with NO succeeded payment to refund against is
			// rejected at the issuable-target check — before any reservation exists.
			if (!res.ok) expect(res.reason).toBe("NO_CAPTURED_PAYMENT");
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
