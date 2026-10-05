import { describe, expect, test } from "vitest";
import { cents, currency as toCurrency } from "../money/cents.js";
import { idempotencyKey, orderId as toOrderId, productId, sku } from "../money/ids.js";
import type { OrderId } from "../money/ids.js";
import type { PaymentMethod } from "../orders/model.js";
import { refundOrder, sumRefunds } from "../orders/refund-order.js";
import { resolveUnverifiedRefund } from "../orders/resolve-unverified-refund.js";
import type { OrderStore } from "../ports/order-store.js";
import { PROVIDER_REFUNDED_FLAG_PREFIX } from "../orders/provider-refunded-flag.js";
import { dispatchOrderEmails } from "../orders/transition.js";
import { FakeEmailSender } from "./fake-email-sender.js";
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

/** Far past any due time a case can stamp — the dispatcher's "now" for a drain. */
const DRAIN_CLOCK = { now: () => new Date("2099-01-01T00:00:00.000Z") };

/** Drain every due outbox row through the real dispatcher into `sender`. */
function drain(h: RefundOrderHarness, sender: FakeEmailSender): Promise<number> {
	return dispatchOrderEmails({ orderStore: h.orderStore, emailSender: sender, clock: DRAIN_CLOCK });
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
 * proven separately in `@otta-sh/payments-stripe`. Postgres additionally runs the
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

		test("a reused key with a DIFFERENT amount is rejected (IDEMPOTENCY_KEY_REUSED), never a false duplicate success", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-idem-amt", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const key = idempotencyKey("rf-idem-amt");
			const first = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(500),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: key,
			});
			expect(first.ok && first.recorded).toBe(true);
			const reused = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(800),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: key,
			});
			expect(reused).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
			expect(gw.refundCalls).toHaveLength(1); // nothing issued for the reuse
			const ledger = await h.orderStore.listRefunds(id);
			expect(ledger).toHaveLength(1);
			expect(ledger[0]?.amount).toBe(500);
		});

		test("a reused key on a DIFFERENT order is rejected (IDEMPOTENCY_KEY_REUSED); the other order is untouched", async () => {
			const h = await makeHarness();
			const a = await h.seedPaidOrder({ id: "ord-idem-a", totalCents: 1000 });
			const b = await h.seedPaidOrder({ id: "ord-idem-b", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const key = idempotencyKey("rf-idem-cross");
			const first = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: a,
				amount: cents(500),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: key,
			});
			expect(first.ok && first.recorded).toBe(true);
			const reused = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: b,
				amount: cents(500),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: key,
			});
			expect(reused).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
			expect(gw.refundCalls).toHaveLength(1);
			expect(await h.orderStore.listRefunds(b)).toHaveLength(0);
		});

		test("a reused key with a different amount on the MANUAL path is rejected too", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-idem-x402", totalCents: 1000, gateway: "x402" });
			const gw = new FakePaymentGateway({ id: "x402" });
			const key = idempotencyKey("rf-idem-x402");
			const cmd = {
				orderId: id,
				amount: cents(300),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: key,
			};
			const first = await refundOrder({ orderStore: h.orderStore }, gw, cmd);
			expect(first.ok && first.recorded).toBe(true);
			const reused = await refundOrder({ orderStore: h.orderStore }, gw, {
				...cmd,
				amount: cents(400),
			});
			expect(reused).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
			const ledger = await h.orderStore.listRefunds(id);
			expect(ledger).toHaveLength(1);
			expect(ledger[0]?.amount).toBe(300);
		});

		test("a reused key with a different amount cannot hijack a held reservation; the genuine retry resumes with the STORED values", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-idem-resume", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			gw.setRefundResult({ ok: false, reason: "RETRYABLE" });
			const key = idempotencyKey("rf-idem-resume");
			const first = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(400),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: key,
			});
			expect(first).toEqual({ ok: false, reason: "GATEWAY_RETRYABLE" });
			expect(gw.refundCalls).toHaveLength(1);

			gw.setRefundResult({ ok: true, refundRef: "re_resume", amount: cents(400), currency: USD });
			const reused = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(900),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: key,
			});
			expect(reused).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
			expect(gw.refundCalls, "a mismatched reuse never reaches the provider").toHaveLength(1);
			const held = await h.orderStore.listRefunds(id);
			expect(held).toHaveLength(1);
			expect(held[0]?.status).toBe("reserved");
			expect(held[0]?.amount).toBe(400);

			const resumed = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(400),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: key,
			});
			expect(resumed.ok && resumed.recorded).toBe(true);
			expect(gw.refundCalls).toHaveLength(2);
			expect(gw.refundCalls[1]?.orderId).toBe(id);
			expect(gw.refundCalls[1]?.amount).toBe(400);
			const ledger = await h.orderStore.listRefunds(id);
			expect(ledger).toHaveLength(1);
			expect(ledger[0]?.status).toBe("recorded");
			expect(ledger[0]?.amount).toBe(400);
		});

		test("a reused key with a different amount on an UNVERIFIED refund reports the reuse, not the other refund's status", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-idem-unver", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			gw.setRefundResult({ ok: false, reason: "UNVERIFIED" });
			const key = idempotencyKey("rf-idem-unver");
			const first = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(400),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: key,
			});
			expect(first).toEqual({ ok: false, reason: "GATEWAY_UNVERIFIED" });
			const reused = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(100),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: key,
			});
			expect(reused).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
			expect(gw.refundCalls).toHaveLength(1);
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

		// Review round 1: Stripe's pre-flight also refuses a refund that would
		// over-refund after a PARTIAL dashboard refund. That is not "refunded outside
		// Otta" — money is still held — so the flag names both amounts and does not
		// unlock Mark refunded.
		test("a PARTIAL provider refund is flagged with both amounts and never as fully refunded", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-preflight-part", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			gw.setRefundResult({
				ok: false,
				reason: "PROVIDER_ALREADY_REFUNDED",
				provider: { refunded: cents(350), captured: cents(1000) },
			});
			await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(1000),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-preflight-part"),
			});
			const flag = (await h.orderStore.getById(id))?.reconciliationFlag ?? "";
			expect(flag).toContain("partially refunded at the provider: 3.50 USD of 10.00 USD");
			expect(flag.startsWith(PROVIDER_REFUNDED_FLAG_PREFIX)).toBe(false);

			// Refunded the rest in the dashboard, then tried again: the newer, full
			// answer replaces the provider's own earlier partial one.
			gw.setRefundResult({
				ok: false,
				reason: "PROVIDER_ALREADY_REFUNDED",
				provider: { refunded: cents(1000), captured: cents(1000) },
			});
			await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(650),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-preflight-part-2"),
			});
			expect((await h.orderStore.getById(id))?.reconciliationFlag).toMatch(
				new RegExp(`^${PROVIDER_REFUNDED_FLAG_PREFIX}`),
			);
		});

		test("a PROVIDER_ALREADY_REFUNDED without the provider's amounts flags nothing (unknown is not refunded)", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-preflight-unknown", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			gw.setRefundResult({ ok: false, reason: "PROVIDER_ALREADY_REFUNDED" });
			await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(500),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-preflight-unknown"),
			});
			expect((await h.orderStore.getById(id))?.reconciliationFlag).toBeNull();
		});

		// Review round 2: the RESUME arm (the pre-flight finds the provider already
		// shows money on a reservation this call did not create) holds the row
		// unverified and flags it — and now names the provider's figures too.
		test("a resumed reservation the provider shows refunded is held unverified, its flag naming the provider's figures", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-resume-figures", totalCents: 1000 });
			const key = idempotencyKey("rf-resume-figures");
			await h.orderStore.reserveRefund({
				orderId: id,
				amount: cents(1000),
				currency: USD,
				kind: "gateway",
				gateway: "stripe",
				refundRef: null,
				reason: null,
				refundedBy: "admin",
				idempotencyKey: key,
			});
			const gw = new FakePaymentGateway({ id: "stripe" });
			gw.setRefundResult({
				ok: false,
				reason: "PROVIDER_ALREADY_REFUNDED",
				provider: { refunded: cents(1000), captured: cents(1000) },
			});
			await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(1000),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: key,
			});
			expect((await h.orderStore.getRefundByIdempotencyKey(key))?.status).toBe("unverified");
			expect((await h.orderStore.getById(id))?.reconciliationFlag).toContain(
				"The provider shows 10.00 USD of 10.00 USD refunded.",
			);
		});

		// Review round 2: an `unverified` refund could never be closed — retries
		// answer GATEWAY_UNVERIFIED, no webhook finalizes it, and Mark refunded and
		// cancel refuse REFUND_IN_FLIGHT. A person resolves it.
		async function unverifiedRefund(h: RefundOrderHarness, idText: string, amount = 1000) {
			const id = await h.seedPaidOrder({ id: idText, totalCents: 1000 });
			const key = idempotencyKey(`rf-unv-${idText}`);
			await h.orderStore.reserveRefund({
				orderId: id,
				amount: cents(amount),
				currency: USD,
				kind: "gateway",
				gateway: "stripe",
				refundRef: null,
				reason: null,
				refundedBy: "admin",
				idempotencyKey: key,
			});
			await h.orderStore.markRefundUnverified(key);
			return { id, key };
		}

		test("resolve CONFIRMED: the row is recorded with the provider id, the order closes, the refunded email goes once, the operator is recorded; a replay changes nothing", async () => {
			const h = await makeHarness();
			const { id, key } = await unverifiedRefund(h, "ord-unv-confirm");
			const sent = new FakeEmailSender();
			await drain(h, sent);
			sent.reset();
			const cmd = {
				orderId: id,
				refundKey: key,
				outcome: "confirmed" as const,
				refundRef: "re_dash_1",
				resolvedBy: "ops@example.test",
			};
			expect(await resolveUnverifiedRefund({ orderStore: h.orderStore }, cmd)).toMatchObject({
				ok: true,
				changed: true,
				fullyRefunded: true,
			});
			const row = await h.orderStore.getRefundByIdempotencyKey(key);
			expect(row).toMatchObject({
				status: "recorded",
				refundRef: "re_dash_1",
				resolvedBy: "ops@example.test",
			});
			expect((await h.orderStore.getById(id))?.state).toBe("refunded");
			expect(await drain(h, sent)).toBe(1);
			expect(sent.countByTemplate("order-refunded", id)).toBe(1);

			expect(await resolveUnverifiedRefund({ orderStore: h.orderStore }, cmd)).toMatchObject({
				ok: true,
				changed: false,
			});
			expect(await drain(h, sent)).toBe(0);
		});

		test("resolve CONFIRMED without a provider id records one that names the operator's confirmation", async () => {
			const h = await makeHarness();
			const { id, key } = await unverifiedRefund(h, "ord-unv-noref", 400);
			await resolveUnverifiedRefund(
				{ orderStore: h.orderStore },
				{ orderId: id, refundKey: key, outcome: "confirmed", resolvedBy: "ops" },
			);
			const row = await h.orderStore.getRefundByIdempotencyKey(key);
			expect(row?.status).toBe("recorded");
			expect(row?.refundRef).toMatch(/^confirmed-by-operator:/);
			expect((await h.orderStore.getById(id))?.state).toBe("paid");
		});

		// Final round: resolving clears the flag that sent the operator here (the
		// resume arm's "never finalized" flag for THIS refund) — compare-and-clear on
		// that exact flag; any other flag stays.
		for (const outcome of ["confirmed", "voided"] as const) {
			test(`resolve ${outcome.toUpperCase()} clears the unverified-refund flag it answers, and only that flag`, async () => {
				const h = await makeHarness();
				const id = await h.seedPaidOrder({ id: `ord-unv-flag-${outcome}`, totalCents: 1000 });
				const key = idempotencyKey(`rf-unv-flag-${outcome}`);
				await h.orderStore.reserveRefund({
					orderId: id,
					amount: cents(400),
					currency: USD,
					kind: "gateway",
					gateway: "stripe",
					refundRef: null,
					reason: null,
					refundedBy: "admin",
					idempotencyKey: key,
				});
				const gw = new FakePaymentGateway({ id: "stripe" });
				gw.setRefundResult({ ok: false, reason: "PROVIDER_ALREADY_REFUNDED" });
				await refundOrder({ orderStore: h.orderStore }, gw, {
					orderId: id,
					amount: cents(400),
					currency: USD,
					refundedBy: "admin",
					idempotencyKey: key,
				});
				expect((await h.orderStore.getById(id))?.reconciliationFlag).toContain(String(key));
				await resolveUnverifiedRefund(
					{ orderStore: h.orderStore },
					{ orderId: id, refundKey: key, outcome, resolvedBy: "ops" },
				);
				const after = await h.orderStore.getById(id);
				expect(after?.reconciliationFlag).toBeNull();
				expect(after?.reconciliationResolution?.resolvedBy).toBe("ops");

				// Any other flag is never cleared by a resolve.
				const other = await unverifiedRefund(h, `ord-unv-flag-other-${outcome}`, 300);
				await h.orderStore.flagReconciliation(other.id, "an unrelated anomaly");
				await resolveUnverifiedRefund(
					{ orderStore: h.orderStore },
					{ orderId: other.id, refundKey: other.key, outcome, resolvedBy: "ops" },
				);
				expect((await h.orderStore.getById(other.id))?.reconciliationFlag).toBe(
					"an unrelated anomaly",
				);
			});
		}

		test("resolve VOIDED: capacity is released, the order stays as it was, nothing is emailed; a replay changes nothing", async () => {
			const h = await makeHarness();
			const { id, key } = await unverifiedRefund(h, "ord-unv-void");
			const sent = new FakeEmailSender();
			await drain(h, sent);
			sent.reset();
			const cmd = {
				orderId: id,
				refundKey: key,
				outcome: "voided" as const,
				resolvedBy: "ops@example.test",
			};
			expect(await resolveUnverifiedRefund({ orderStore: h.orderStore }, cmd)).toMatchObject({
				ok: true,
				changed: true,
			});
			expect(await h.orderStore.getRefundByIdempotencyKey(key)).toMatchObject({
				status: "voided",
				resolvedBy: "ops@example.test",
			});
			expect(sumRefunds(await h.orderStore.listRefunds(id)), "capacity released").toBe(0);
			expect((await h.orderStore.getById(id))?.state).toBe("paid");
			expect(await drain(h, sent)).toBe(0);
			expect(await resolveUnverifiedRefund({ orderStore: h.orderStore }, cmd)).toMatchObject({
				ok: true,
				changed: false,
			});
			// Capacity back: a fresh refund now fits.
			const fresh = await refundOrder(
				{ orderStore: h.orderStore },
				new FakePaymentGateway({ id: "stripe" }),
				{
					orderId: id,
					amount: cents(1000),
					currency: USD,
					refundedBy: "admin",
					idempotencyKey: idempotencyKey("rf-unv-void-fresh"),
				},
			);
			expect(fresh.ok).toBe(true);
		});

		test("only an UNVERIFIED row can be resolved: a reserved, a recorded the other way, a voided the other way, or a missing one is refused", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-unv-guard", totalCents: 1000 });
			const reservedKey = idempotencyKey("rf-unv-guard-reserved");
			await h.orderStore.reserveRefund({
				orderId: id,
				amount: cents(200),
				currency: USD,
				kind: "gateway",
				gateway: "stripe",
				refundRef: null,
				reason: null,
				refundedBy: "admin",
				idempotencyKey: reservedKey,
			});
			const resolve = (refundKey: string, outcome: "confirmed" | "voided") =>
				resolveUnverifiedRefund(
					{ orderStore: h.orderStore },
					{ orderId: id, refundKey: idempotencyKey(refundKey), outcome, resolvedBy: "ops" },
				);
			expect(await resolve(reservedKey, "confirmed")).toEqual({
				ok: false,
				reason: "NOT_UNVERIFIED",
			});
			expect(await resolve("rf-nope", "voided")).toEqual({ ok: false, reason: "REFUND_NOT_FOUND" });

			const recorded = await refundOrder(
				{ orderStore: h.orderStore },
				new FakePaymentGateway({ id: "stripe" }),
				{
					orderId: id,
					amount: cents(300),
					currency: USD,
					refundedBy: "admin",
					idempotencyKey: idempotencyKey("rf-unv-guard-recorded"),
				},
			);
			expect(recorded.ok).toBe(true);
			expect(await resolve("rf-unv-guard-recorded", "voided")).toEqual({
				ok: false,
				reason: "NOT_UNVERIFIED",
			});
			expect(await resolve(reservedKey, "voided")).toEqual({ ok: false, reason: "NOT_UNVERIFIED" });
			// Another order's refund key never resolves against this order.
			const other = await unverifiedRefund(h, "ord-unv-guard-other");
			expect(
				await resolveUnverifiedRefund(
					{ orderStore: h.orderStore },
					{ orderId: id, refundKey: other.key, outcome: "voided", resolvedBy: "ops" },
				),
			).toEqual({ ok: false, reason: "REFUND_NOT_FOUND" });
		});

		test("a PROVIDER_ALREADY_REFUNDED never overwrites an order's open reconciliation flag", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-preflight-flagged", totalCents: 1000 });
			await h.orderStore.flagReconciliation(id, "an earlier anomaly");
			const gw = new FakePaymentGateway({ id: "stripe" });
			gw.setRefundResult({
				ok: false,
				reason: "PROVIDER_ALREADY_REFUNDED",
				provider: { refunded: cents(1000), captured: cents(1000) },
			});
			await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(500),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-preflight-flagged"),
			});
			expect((await h.orderStore.getById(id))?.reconciliationFlag).toBe("an earlier anomaly");
		});

		test("a PROVIDER_ALREADY_REFUNDED never overwrites a flag written WHILE the provider was being asked (issue #364)", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-preflight-race", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			gw.setRefundResult({
				ok: false,
				reason: "PROVIDER_ALREADY_REFUNDED",
				provider: { refunded: cents(1000), captured: cents(1000) },
			});
			// The order was unflagged when the refund read it; an anomaly lands on it
			// during the provider round trip.
			const racing = Object.assign(Object.create(gw) as FakePaymentGateway, {
				async refund(input: Parameters<FakePaymentGateway["refund"]>[0]) {
					await h.orderStore.flagReconciliation(id, "an anomaly raised meanwhile");
					return gw.refund(input);
				},
			});
			const res = await refundOrder({ orderStore: h.orderStore }, racing, {
				orderId: id,
				amount: cents(500),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-preflight-race"),
			});
			expect(res).toEqual({ ok: false, reason: "PROVIDER_ALREADY_REFUNDED" });
			expect((await h.orderStore.getById(id))?.reconciliationFlag).toBe(
				"an anomaly raised meanwhile",
			);
		});

		test("a gateway PROVIDER_ALREADY_REFUNDED fails closed — reservation voided, capacity released", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-preflight", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			gw.setRefundResult({
				ok: false,
				reason: "PROVIDER_ALREADY_REFUNDED",
				provider: { refunded: cents(1000), captured: cents(1000) },
			});
			const res = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(500),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-preflight"),
			});
			expect(res).toEqual({ ok: false, reason: "PROVIDER_ALREADY_REFUNDED" });
			// The provider's own word that the payment is FULLY refunded is kept on the
			// order (QA2 M4): it is what lets the admin close an order refunded outside
			// Otta with Mark refunded — and it says to do that BEFORE resolving it.
			const flag = (await h.orderStore.getById(id))?.reconciliationFlag ?? "";
			expect(flag).toMatch(new RegExp(`^${PROVIDER_REFUNDED_FLAG_PREFIX}`));
			expect(flag).toMatch(/Mark refunded.*before.*resolv/i);
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

		test("a RESUMED reservation whose provider pre-flight already shows the refund is held UNVERIFIED and flagged, never left reserved", async () => {
			// The crash-heal window: an earlier attempt's refunds.create succeeded at
			// the provider but the process died (or the call failed retryably) before
			// finalize. A same-key resume's pre-flight now sees money the ledger never
			// finalized and fails closed. The row is not this call's to void — but it
			// must not sit `reserved` forever either: it becomes `unverified` (still
			// holding capacity) and the order is flagged for a human to reconcile.
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-resume-already", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const cmd = {
				orderId: id,
				amount: cents(600),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-resume-already"),
			};
			gw.setRefundResult({ ok: false, reason: "RETRYABLE" });
			expect(await refundOrder({ orderStore: h.orderStore }, gw, cmd)).toEqual({
				ok: false,
				reason: "GATEWAY_RETRYABLE",
			});

			gw.setRefundResult({ ok: false, reason: "PROVIDER_ALREADY_REFUNDED" });
			expect(await refundOrder({ orderStore: h.orderStore }, gw, cmd)).toEqual({
				ok: false,
				reason: "GATEWAY_UNVERIFIED",
			});
			const ledger = await h.orderStore.listRefunds(id);
			expect(ledger.map((r) => r.status)).toEqual(["unverified"]);
			expect(sumRefunds(ledger), "the capacity stays held").toBe(600);
			const order = await h.orderStore.getById(id);
			expect(order?.reconciliationFlag ?? null).not.toBeNull();
			expect(order?.state).toBe("paid");

			// And a further same-key replay asks the provider for nothing.
			const calls = gw.refundCalls.length;
			expect(await refundOrder({ orderStore: h.orderStore }, gw, cmd)).toEqual({
				ok: false,
				reason: "GATEWAY_UNVERIFIED",
			});
			expect(gw.refundCalls).toHaveLength(calls);
		});

		test("finalizeRefund is status-guarded: it never clobbers a voided row, and a same-ref re-finalize is a benign duplicate", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-guarded", totalCents: 1000 });
			const key = idempotencyKey("rf-guarded");
			const reserveInput = {
				orderId: id,
				amount: cents(400),
				currency: USD,
				kind: "gateway" as const,
				gateway: "stripe" as const,
				refundRef: null,
				reason: null,
				refundedBy: "admin",
				idempotencyKey: key,
			};

			// reserve → void → a STRAY finalize must be a 0-row miss: found:false, the
			// voided row untouched (still voided, refundRef still null) — never a
			// resurrection of released capacity.
			expect((await h.orderStore.reserveRefund(reserveInput)).outcome).toBe("recorded");
			expect(await h.orderStore.voidRefund(key)).toBe(true);
			const stray = await h.orderStore.finalizeRefund({
				idempotencyKey: key,
				refundRef: "re_stray",
			});
			expect(stray.found).toBe(false);
			expect(stray.alreadyFinalized).toBe(false);
			const afterStray = await h.orderStore.getRefundByIdempotencyKey(key);
			expect(afterStray?.status, "voided row NOT clobbered").toBe("voided");
			expect(afterStray?.refundRef).toBeNull();

			// reserve (fresh key) → finalize → a SECOND finalize with the SAME ref is
			// the benign duplicate (found:true, alreadyFinalized:true, same row); a
			// DIFFERENT ref is found:false (the loud residual) and the recorded row —
			// including its refundRef — is untouched.
			const key2 = idempotencyKey("rf-guarded-2");
			expect(
				(await h.orderStore.reserveRefund({ ...reserveInput, idempotencyKey: key2 })).outcome,
			).toBe("recorded");
			const first = await h.orderStore.finalizeRefund({ idempotencyKey: key2, refundRef: "re_a" });
			expect(first.found).toBe(true);
			expect(first.alreadyFinalized).toBe(false);
			const dup = await h.orderStore.finalizeRefund({ idempotencyKey: key2, refundRef: "re_a" });
			expect(dup.found).toBe(true);
			expect(dup.alreadyFinalized, "same-ref re-finalize is benign").toBe(true);
			expect(dup.refund?.refundRef).toBe("re_a");
			const other = await h.orderStore.finalizeRefund({ idempotencyKey: key2, refundRef: "re_b" });
			expect(other.found, "different ref is NOT benign").toBe(false);
			const recordedRow = await h.orderStore.getRefundByIdempotencyKey(key2);
			expect(recordedRow?.status).toBe("recorded");
			expect(recordedRow?.refundRef, "recorded row not clobbered").toBe("re_a");
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

		// -- the buyer's refund emails (QA T1-6) ----------------------------------
		//
		// One outbox mechanism carries every non-state email (ADR-0026): a partial
		// refund is a `refund-issued` NOTICE row, first-wins per (order, kind,
		// refundId), stating its own amount through the notice render path.

		test("a partial refund emails the buyer ONCE, stating the amount refunded — its replay sends nothing more", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-mail-partial", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const sent = new FakeEmailSender();
			await drain(h, sent); // the seed's own payment confirmation
			sent.reset();
			const cmd = {
				orderId: id,
				amount: cents(300),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-mail-partial"),
			};
			await refundOrder({ orderStore: h.orderStore }, gw, cmd);
			expect(await drain(h, sent)).toBe(1);
			expect(sent.countByTemplate("order-refund-issued", id)).toBe(1);
			expect(sent.sends[0]?.data["noticeAmountCents"]).toBe(300);
			await refundOrder({ orderStore: h.orderStore }, gw, cmd);
			expect(await drain(h, sent)).toBe(0);
		});

		test("each partial refund gets its own email; the one that completes the refund sends the refunded email with the total refunded", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-mail-two", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const sent = new FakeEmailSender();
			await drain(h, sent);
			sent.reset();
			for (const [amount, key] of [
				[300, "rf-mail-two-a"],
				[200, "rf-mail-two-b"],
				[500, "rf-mail-two-c"],
			] as const) {
				await refundOrder({ orderStore: h.orderStore }, gw, {
					orderId: id,
					amount: cents(amount),
					currency: USD,
					refundedBy: "admin",
					idempotencyKey: idempotencyKey(key),
				});
			}
			expect(await drain(h, sent)).toBe(3);
			const partials = sent.sends.filter((m) => m.template === "order-refund-issued");
			expect(partials.map((m) => m.data["noticeAmountCents"])).toEqual([300, 200]);
			const full = sent.sends.filter((m) => m.template === "order-refunded");
			expect(full).toHaveLength(1);
			expect(full[0]?.data["noticeAmountCents"]).toBe(1000);
		});

		test("a refund still held (RETRYABLE) emails nobody until it is finalized", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-mail-held", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const sent = new FakeEmailSender();
			await drain(h, sent);
			sent.reset();
			gw.setRefundResult({ ok: false, reason: "RETRYABLE" });
			const cmd = {
				orderId: id,
				amount: cents(400),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-mail-held"),
			};
			await refundOrder({ orderStore: h.orderStore }, gw, cmd);
			expect(await drain(h, sent)).toBe(0);
			gw.setRefundResult({ ok: true, refundRef: "re_held", amount: cents(400), currency: USD });
			await refundOrder({ orderStore: h.orderStore }, gw, cmd);
			expect(await drain(h, sent)).toBe(1);
			expect(sent.sends[0]?.data["noticeAmountCents"]).toBe(400);
		});

		test("a MANUAL partial refund (x402) emails the buyer the amount too", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-mail-man", totalCents: 800, gateway: "x402" });
			const gw = new FakePaymentGateway({ id: "x402", refundable: false });
			const sent = new FakeEmailSender();
			await drain(h, sent);
			sent.reset();
			await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(250),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-mail-man"),
			});
			expect(await drain(h, sent)).toBe(1);
			expect(sent.countByTemplate("order-refund-issued", id)).toBe(1);
		});

		test("a cancellation's or a late payment's refund sends no admin refund email of its own", async () => {
			const h = await makeHarness();
			const gw = new FakePaymentGateway({ id: "stripe" });
			const sent = new FakeEmailSender();
			for (const purpose of ["cancellation", "late-payment"] as const) {
				const id = await h.seedPaidOrder({ id: `ord-mail-${purpose}`, totalCents: 1000 });
				await drain(h, sent);
				sent.reset();
				await refundOrder({ orderStore: h.orderStore }, gw, {
					orderId: id,
					amount: cents(400),
					currency: USD,
					refundedBy: "admin",
					idempotencyKey: idempotencyKey(`rf-mail-${purpose}`),
					purpose,
				});
				expect(await drain(h, sent), purpose).toBe(0);
			}
		});

		// -- a refund made AS PART OF a cancellation (QA T1-4) ---------------------

		test("a cancellation's gateway refund of the whole ceiling is recorded but does NOT flip the order to refunded", async () => {
			// The cancellation closes the order (→ cancelled), so the refund that rides it
			// must not drive → refunded first — that would make the cancel illegal and send
			// a second, refunded email.
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-cxl-gw", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const res = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(1000),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-cxl-gw"),
				purpose: "cancellation",
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.recorded).toBe(true);
			expect(res.fullyRefunded).toBe(false);
			expect(res.order.state).toBe("paid");
			expect(res.refund).toMatchObject({ status: "recorded", purpose: "cancellation" });
			expect(gw.refundCalls).toHaveLength(1);
			const ledger = await h.orderStore.listRefunds(id);
			expect(ledger).toHaveLength(1);
			expect(ledger[0]).toMatchObject({ amount: 1000, purpose: "cancellation" });
			// Its replay is the ordinary benign duplicate: no second provider call.
			const replay = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(1000),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-cxl-gw"),
				purpose: "cancellation",
			});
			expect(replay).toMatchObject({ ok: true, duplicate: true });
			expect(gw.refundCalls).toHaveLength(1);
			// The ceiling still binds: the cancellation's refund consumed it.
			const more = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(1),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-cxl-gw-more"),
			});
			expect(more).toEqual({ ok: false, reason: "REFUND_EXCEEDS_TOTAL" });
		});

		test("a cancellation's MANUAL refund of the whole ceiling does not flip the order either", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-cxl-man", totalCents: 800, gateway: "x402" });
			const gw = new FakePaymentGateway({ id: "x402", refundable: false });
			const res = await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(800),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-cxl-man"),
				purpose: "cancellation",
			});
			expect(res).toMatchObject({ ok: true, recorded: true, fullyRefunded: false });
			expect((await h.orderStore.getById(id))?.state).toBe("paid");
			expect((await h.orderStore.listRefunds(id))[0]?.purpose).toBe("cancellation");
		});

		test("an ordinary refund is recorded with purpose refund", async () => {
			const h = await makeHarness();
			const id = await h.seedPaidOrder({ id: "ord-purpose", totalCents: 1000 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(100),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-purpose"),
			});
			expect((await h.orderStore.listRefunds(id))[0]?.purpose).toBe("refund");
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
