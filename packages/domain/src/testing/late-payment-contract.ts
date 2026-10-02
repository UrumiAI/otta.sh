import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import { idempotencyKey, orderId, productId, reservationId, sku } from "../money/ids.js";
import type { OrderId } from "../money/ids.js";
import { cancelOrder } from "../orders/cancel-order.js";
import { expireOrders } from "../orders/expire-orders.js";
import {
	escalateStaleLateRefunds,
	latePaymentRefundKey,
	readOrderWithLatePayment,
	retryLatePaymentRefunds,
} from "../orders/late-payment.js";
import type { Order } from "../orders/model.js";
import { settleOrder } from "../orders/settle-order.js";
import type { OrderNoticeInput, OrderStore } from "../ports/order-store.js";
import type { PaymentGateway, RefundInput, RefundResult } from "../ports/payment-gateway.js";
import { FakePaymentGateway } from "./fake-payment-gateway.js";
import type { SeedOrderSummaryRow } from "./in-memory-order-store.js";
import type { PaymentDeclineHarness } from "./payment-decline-contract.js";

const USD = currency("USD");
const ON_HAND = 5;
const QTY = 2;
const UNIT_CENTS = 750;
const TOTAL_CENTS = UNIT_CENTS * QTY;
const HOLD_MS = 15 * 60 * 1000;

/**
 * The late-payment spec runs on the decline spec's harness — one adapter family's
 * stores, shared between the settle deps and the expiry deps — plus ONE hook the
 * ports cannot provide: an order written with NO state-change audit, the shape
 * every order that predates the audit log has. That is what the "positive
 * evidence" rule exists for, so it must be provable on every adapter.
 */
export interface LatePaymentHarness extends PaymentDeclineHarness {
	/** Write a bare order (header + totals, no lines, NO events) in `row.state`. */
	seedOrderWithoutAudit(row: SeedOrderSummaryRow): Promise<void>;
}

export interface LatePaymentContractOptions {
	dialect: string;
}

interface Seeded {
	order: Order;
	sku: string;
	intentId: string;
	holdExpiresAt: Date;
}

/** A pending PHYSICAL order holding `QTY` units, built through the ports alone. */
async function seedPendingOrder(h: LatePaymentHarness, n: string): Promise<Seeded> {
	const { inventoryStore, orderStore, clock } = h.settleDeps;
	const now = clock.now();
	const holdExpiresAt = new Date(now.getTime() + HOLD_MS);
	const skuStr = `SKU-LATE-${n}`;
	const oid = orderId(`ord-late-${n}`);

	await inventoryStore.seedOnHand(skuStr, ON_HAND);
	const heldId = await h.holdForCheckout(skuStr, QTY, `late-res-${n}`, holdExpiresAt.toISOString());
	const created = await orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`late-order-${n}`),
		holdExpiresAt: holdExpiresAt.toISOString(),
		buyerRef: `buyer-${n}@example.com`,
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId(`p-late-${n}`),
				sku: sku(skuStr),
				title: "Widget",
				unitPrice: cents(UNIT_CENTS),
				currency: USD,
				quantity: QTY,
				fulfillmentKind: "physical",
				reservationId: reservationId(heldId),
			},
		],
		totals: { subtotal: cents(TOTAL_CENTS), total: cents(TOTAL_CENTS), currency: USD },
	});
	const adopted = await inventoryStore.adopt({
		reservationId: heldId,
		orderId: oid,
		holdExpiresAt: holdExpiresAt.toISOString(),
		now: now.toISOString(),
	});
	if (!adopted.ok) throw new Error(`seed adopt failed: ${adopted.reason}`);
	return { order: created.order, sku: skuStr, intentId: `pi_late_${n}`, holdExpiresAt };
}

/** A pending order, then expired by the sweep past its hold. */
async function seedExpiredOrder(h: LatePaymentHarness, n: string): Promise<Seeded> {
	const s = await seedPendingOrder(h, n);
	const due = new Date(s.holdExpiresAt.getTime() + 60_000);
	if ((await expireOrders(h.expireDeps, due)) !== 1) throw new Error("seed expiry failed");
	return s;
}

/** A verified success for the seeded order's own intent, as the gateway signs it. */
function succeeded(gateway: FakePaymentGateway, s: Seeded, dedupeKey: string) {
	return gateway.webhook({
		outcome: "succeeded",
		orderId: s.order.id,
		providerRef: s.intentId,
		amount: TOTAL_CENTS,
		currency: "USD",
		dedupeKey,
	});
}

async function state(h: LatePaymentHarness, id: OrderId): Promise<Order> {
	const order = await h.settleDeps.orderStore.getById(id);
	if (order === null) throw new Error(`order ${id} vanished`);
	return order;
}

async function latePayment(h: LatePaymentHarness, id: OrderId): Promise<string | undefined> {
	return (await readOrderWithLatePayment(h.settleDeps.orderStore, id))?.latePayment;
}

/** Drain the outbox through the PORT and collect the notices it held for `id`. */
async function drainNotices(
	store: OrderStore,
	id: OrderId,
	now: string,
): Promise<OrderNoticeInput[]> {
	const found: OrderNoticeInput[] = [];
	for (let i = 0; i < 50; i++) {
		const row = await store.claimNextEmail(now, "9999-01-01T00:00:00.000Z");
		if (row === null) break;
		if (row.orderId === id && row.notice !== null) found.push(row.notice);
		await store.markEmailSent(row.id, now);
	}
	return found;
}

function retryDeps(h: LatePaymentHarness, gateway: PaymentGateway) {
	return {
		orderStore: h.settleDeps.orderStore,
		paymentEventStore: h.settleDeps.paymentEventStore,
		clock: h.settleDeps.clock,
		gateways: () => ({ stripe: gateway }),
	};
}

/** A refund-capable gateway that ISSUES the refund at the provider and then dies
 *  before answering — the crash window between Stripe moving money and our
 *  ledger hearing about it. */
function issuesThenCrashes(inner: FakePaymentGateway): PaymentGateway {
	return {
		id: inner.id,
		refundable: true,
		createIntent: (i) => inner.createIntent(i),
		verifyConfirmation: (raw) => inner.verifyConfirmation(raw),
		cancelIntent: (input) => inner.cancelIntent(input),
		async refund(input: RefundInput): Promise<RefundResult> {
			await inner.refund(input);
			throw new Error("connection reset after the refund was issued");
		},
	};
}

/**
 * THE LATE-PAYMENT CURE. A verified success that lands on an order which provably
 * left `pending` unpaid is refunded automatically, EXACTLY ONCE across any number
 * of redeliveries and sweep resumes (one ledger row, keyed on the captured
 * payment); the reconciliation flag says what a human should do while it is not
 * done, and is resolved with an `auto-refund` disposition when it is; the buyer
 * gets ONE notice carrying the refunded amount. Whatever happens, a captured
 * payment on a dead order is never reported as "nothing charged".
 *
 * Every observation goes through the ports, so the same cases run on the
 * in-memory fake and on every document-store dialect.
 */
export function latePaymentContract(
	makeHarness: () => LatePaymentHarness | Promise<LatePaymentHarness>,
	opts: LatePaymentContractOptions,
): void {
	describe(`latePaymentContract [${opts.dialect}]`, () => {
		test("a payment that lands after expiry is refunded exactly once across redeliveries; the flag is resolved and the buyer told once, with the refunded amount", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedExpiredOrder(h, "1");
			const store = h.settleDeps.orderStore;
			const now = h.settleDeps.clock.now().toISOString();
			await drainNotices(store, s.order.id, now); // the expiry email is not the subject

			for (let delivery = 0; delivery < 3; delivery++) {
				const res = await settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_1"));
				expect(res.ok, `delivery ${String(delivery)}`).toBe(true);
			}

			expect(gateway.refundCalls).toHaveLength(1);
			expect(gateway.refundCalls[0]?.amount).toBe(TOTAL_CENTS);
			expect(gateway.refundCalls[0]?.providerRef).toBe(s.intentId);
			expect(gateway.refundCalls[0]?.idempotencyKey).toBe(latePaymentRefundKey(s.intentId));
			const refunds = await store.listRefunds(s.order.id);
			expect(refunds.map((r) => [r.amount, r.status])).toEqual([[TOTAL_CENTS, "recorded"]]);
			expect(await store.getCapturedPayments(s.order.id)).toHaveLength(1);

			const after = await state(h, s.order.id);
			expect(after.state, "a late payment never revives the order").toBe("expired");
			expect(after.reconciliationFlag).toBeNull();
			expect(after.reconciliationResolution?.outcome).toBe("refunded");
			expect(await h.settleDeps.inventoryStore.getOnHand(s.sku), "stock is not re-taken").toBe(
				ON_HAND,
			);
			expect(await latePayment(h, s.order.id)).toBe("refunded");
			expect(await store.listRefundRetriesDue("9999-01-01T00:00:00.000Z", 10)).toEqual([]);

			expect(await drainNotices(store, s.order.id, now)).toEqual([
				{ kind: "late-payment-refunded", amount: TOTAL_CENTS, currency: USD },
			]);
			await settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_1"));
			expect(await drainNotices(store, s.order.id, now), "no second email").toEqual([]);
		});

		test("two deliveries of the same event settling CONCURRENTLY refund once and notify once", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedExpiredOrder(h, "2");
			const store = h.settleDeps.orderStore;
			const now = h.settleDeps.clock.now().toISOString();
			await drainNotices(store, s.order.id, now);

			const results = await Promise.all([
				settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_2")),
				settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_2")),
			]);

			expect(results.every((r) => r.ok)).toBe(true);
			// Any provider calls the two made share ONE key — Stripe's native
			// idempotency makes them one refund — and the ledger holds one row.
			expect(new Set(gateway.refundCalls.map((c) => c.idempotencyKey)).size).toBe(1);
			const refunds = await store.listRefunds(s.order.id);
			expect(refunds.filter((r) => r.status === "recorded")).toHaveLength(1);
			expect((await state(h, s.order.id)).reconciliationFlag).toBeNull();
			expect(await drainNotices(store, s.order.id, now)).toHaveLength(1);
		});

		test("a RETRYABLE failure answers retryable, flags 'retrying' and schedules a sweep retry — which completes the SAME refund", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedExpiredOrder(h, "3");
			const store = h.settleDeps.orderStore;

			gateway.setRefundResult({ ok: false, reason: "RETRYABLE" });
			const first = await settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_3"));
			expect(first).toEqual({ ok: false, reason: "LATE_PAYMENT_REFUND_RETRYABLE" });
			expect((await state(h, s.order.id)).reconciliationFlag).toContain(
				"automatic refund retrying",
			);
			expect(await latePayment(h, s.order.id), "captured, not yet back").toBe("refund_pending");
			expect(await store.listRefundRetriesDue("9999-01-01T00:00:00.000Z", 10)).toEqual([
				s.order.id,
			]);

			// Stripe stopped redelivering; the provider recovered; the SWEEP resumes it.
			gateway.clearRefundResult();
			const later = new Date(Date.parse(h.settleDeps.clock.now().toISOString()) + 3_600_000);
			const deps = { ...retryDeps(h, gateway), clock: { now: () => later } };
			expect(await retryLatePaymentRefunds(deps)).toBe(1);

			expect(new Set(gateway.refundCalls.map((c) => c.idempotencyKey)).size).toBe(1);
			const refunds = await store.listRefunds(s.order.id);
			expect(refunds.map((r) => r.status)).toEqual(["recorded"]);
			expect((await state(h, s.order.id)).reconciliationFlag).toBeNull();
			expect(await latePayment(h, s.order.id)).toBe("refunded");
			expect(await store.listRefundRetriesDue("9999-01-01T00:00:00.000Z", 10)).toEqual([]);
			expect(await retryLatePaymentRefunds(deps), "nothing left to resume").toBe(0);
		});

		test("transient failures back off 5 min → 15 min → 1 h (capped), counted per refund", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedExpiredOrder(h, "3b");
			const store = h.settleDeps.orderStore;
			gateway.setRefundResult({ ok: false, reason: "RETRYABLE" });
			const t0 = Date.parse(h.settleDeps.clock.now().toISOString());
			await settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_3b"));

			const retryOf = async () => (await store.readOrderLedger(s.order.id))?.refundRetries[0];
			const MIN = 60_000;
			expect(await retryOf()).toMatchObject({
				attempts: 1,
				at: new Date(t0 + 5 * MIN).toISOString(),
				since: new Date(t0).toISOString(),
			});
			const steps = [
				[5 * MIN, 2, 15 * MIN],
				[20 * MIN, 3, 60 * MIN],
				[80 * MIN, 4, 60 * MIN],
			] as const;
			for (const [offset, attempts, wait] of steps) {
				const now = new Date(t0 + offset);
				await retryLatePaymentRefunds({ ...retryDeps(h, gateway), clock: { now: () => now } });
				expect(await retryOf(), `attempt ${String(attempts)}`).toMatchObject({
					attempts,
					at: new Date(t0 + offset + wait).toISOString(),
					since: new Date(t0).toISOString(),
				});
			}
		});

		test("after ~3 days of transient failures the sweep GIVES UP: schedule cleared, flagged 'verify in Stripe', the reservation KEPT (unverified) — never voided blind", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedExpiredOrder(h, "3c");
			const store = h.settleDeps.orderStore;
			gateway.setRefundResult({ ok: false, reason: "RETRYABLE" });
			const t0 = Date.parse(h.settleDeps.clock.now().toISOString());
			await settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_3c"));

			const later = new Date(t0 + 3 * 24 * 3_600_000 + 60_000);
			await retryLatePaymentRefunds({ ...retryDeps(h, gateway), clock: { now: () => later } });

			expect(await store.listRefundRetriesDue("9999-01-01T00:00:00.000Z", 10)).toEqual([]);
			const flag = (await state(h, s.order.id)).reconciliationFlag ?? "";
			expect(flag).toContain("needs checking");
			expect(flag).toContain("verify in Stripe");
			expect((await store.listRefunds(s.order.id)).map((r) => r.status)).toEqual(["unverified"]);
		});

		test("a retry with NO gateway (a secret missing or unreadable this time) backs off like any transient failure — it is given up only past the age limit", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedExpiredOrder(h, "3d");
			const store = h.settleDeps.orderStore;
			gateway.setRefundResult({ ok: false, reason: "RETRYABLE" });
			const t0 = Date.parse(h.settleDeps.clock.now().toISOString());
			await settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_3d"));
			const noGateway = (at: number) => ({
				...retryDeps(h, gateway),
				clock: { now: () => new Date(at) },
				gateways: () => ({}),
			});

			await retryLatePaymentRefunds(noGateway(t0 + 3_600_000));
			expect((await store.listRefunds(s.order.id)).map((r) => r.status)).toEqual(["reserved"]);
			const retry = (await store.readOrderLedger(s.order.id))?.refundRetries[0];
			expect(retry?.attempts).toBe(2);
			expect((await state(h, s.order.id)).reconciliationFlag ?? "").toContain("retrying");

			await retryLatePaymentRefunds(noGateway(t0 + 3 * 24 * 3_600_000 + 60_000));
			expect(await store.listRefundRetriesDue("9999-01-01T00:00:00.000Z", 10)).toEqual([]);
			expect((await state(h, s.order.id)).reconciliationFlag ?? "").toContain("needs checking");
			expect((await store.listRefunds(s.order.id)).map((r) => r.status)).toEqual(["unverified"]);
		});

		test("ESCALATION — no provider call — gives up a retry past the age limit, and leaves a younger one alone", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedExpiredOrder(h, "3f");
			const store = h.settleDeps.orderStore;
			gateway.setRefundResult({ ok: false, reason: "RETRYABLE" });
			const t0 = Date.parse(h.settleDeps.clock.now().toISOString());
			await settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_3f"));
			const calls = gateway.refundCalls.length;
			const deps = (at: number) => ({
				...retryDeps(h, gateway),
				clock: { now: () => new Date(at) },
			});

			expect(await escalateStaleLateRefunds(deps(t0 + 2 * 3_600_000))).toBe(0);
			expect((await store.listRefunds(s.order.id)).map((r) => r.status)).toEqual(["reserved"]);

			expect(await escalateStaleLateRefunds(deps(t0 + 3 * 24 * 3_600_000 + 60_000))).toBe(1);
			expect(gateway.refundCalls, "escalation never calls the provider").toHaveLength(calls);
			expect((await store.listRefunds(s.order.id)).map((r) => r.status)).toEqual(["unverified"]);
			expect(await store.listRefundRetriesDue("9999-01-01T00:00:00.000Z", 10)).toEqual([]);
			const flag = (await state(h, s.order.id)).reconciliationFlag ?? "";
			expect(flag).toContain("needs checking");
			expect(flag).toContain("verify in Stripe");
		});

		test("ESCALATION never flags a refund already RECORDED — it finishes it (a finish that crashed after the finalize)", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedExpiredOrder(h, "3h");
			const store = h.settleDeps.orderStore;
			gateway.setRefundResult({ ok: false, reason: "RETRYABLE" });
			const t0 = Date.parse(h.settleDeps.clock.now().toISOString());
			await settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_3h"));
			// The refund went through, but the process died before `finish` cleared the
			// retry, resolved the flag and enqueued the notice.
			const key = latePaymentRefundKey(s.intentId);
			const finalized = await store.finalizeRefund({ idempotencyKey: key, refundRef: "re_3h" });
			expect(finalized.found).toBe(true);
			const now = h.settleDeps.clock.now().toISOString();
			await drainNotices(store, s.order.id, now);

			const stale = t0 + 3 * 24 * 3_600_000 + 60_000;
			await escalateStaleLateRefunds({
				...retryDeps(h, gateway),
				clock: { now: () => new Date(stale) },
			});

			expect((await store.listRefunds(s.order.id)).map((r) => r.status)).toEqual(["recorded"]);
			const after = await state(h, s.order.id);
			expect(after.reconciliationFlag, "never re-flagged 'needs checking'").toBeNull();
			expect(after.reconciliationResolution?.outcome).toBe("refunded");
			expect(await store.listRefundRetriesDue("9999-01-01T00:00:00.000Z", 10)).toEqual([]);
			expect((await drainNotices(store, s.order.id, now)).map((n) => n.kind)).toEqual([
				"late-payment-refunded",
			]);
		});

		test("a create the CALLER declined to start (no time left) is NOT_STARTED: not an attempt, the row still reserved and due again", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedExpiredOrder(h, "3i");
			const store = h.settleDeps.orderStore;
			gateway.setRefundResult({ ok: false, reason: "RETRYABLE" });
			const t0 = Date.parse(h.settleDeps.clock.now().toISOString());
			await settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_3i"));
			const before = (await store.readOrderLedger(s.order.id))?.refundRetries[0];

			gateway.setRefundResult({ ok: false, reason: "NOT_STARTED" });
			await retryLatePaymentRefunds({
				...retryDeps(h, gateway),
				clock: { now: () => new Date(t0 + 3_600_000) },
			});

			expect((await store.listRefunds(s.order.id)).map((r) => r.status)).toEqual(["reserved"]);
			const retry = (await store.readOrderLedger(s.order.id))?.refundRetries[0];
			expect(retry?.attempts, "not counted").toBe(before?.attempts);
			expect(retry?.since).toBe(before?.since);
			expect((retry?.at ?? "") > new Date(t0 + 3_600_000).toISOString()).toBe(true);
		});

		test("the retry gate is asked PER REFUND: an order with two due late refunds runs one unit when only one is allowed", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedExpiredOrder(h, "3g");
			gateway.setRefundResult({ ok: false, reason: "RETRYABLE" });
			for (const ref of ["pi_3g_a", "pi_3g_b"]) {
				await settleOrder(
					h.settleDeps,
					gateway,
					gateway.webhook({
						outcome: "succeeded",
						orderId: s.order.id,
						providerRef: ref,
						amount: 700,
						currency: "USD",
						dedupeKey: `evt_${ref}`,
					}),
				);
			}
			gateway.clearRefundResult();
			const before = gateway.refundCalls.length;
			let allowed = 1;
			const later = new Date(Date.parse(h.settleDeps.clock.now().toISOString()) + 3_600_000);

			const done = await retryLatePaymentRefunds(
				{ ...retryDeps(h, gateway), clock: { now: () => later } },
				{ shouldContinue: () => allowed-- > 0 },
			);

			expect(done).toBe(1);
			expect(gateway.refundCalls.length - before).toBe(1);
		});

		test("two late captures on one order: resuming one never clears the retry the other still needs", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedExpiredOrder(h, "3e");
			const store = h.settleDeps.orderStore;
			gateway.setRefundResult({ ok: false, reason: "RETRYABLE" });
			for (const ref of ["pi_3e_a", "pi_3e_b"]) {
				await settleOrder(
					h.settleDeps,
					gateway,
					gateway.webhook({
						outcome: "succeeded",
						orderId: s.order.id,
						providerRef: ref,
						amount: 700,
						currency: "USD",
						dedupeKey: `evt_${ref}`,
					}),
				);
			}
			// The provider recovers for ONE of them only.
			const flaky: PaymentGateway = {
				id: gateway.id,
				refundable: true,
				createIntent: (i) => gateway.createIntent(i),
				verifyConfirmation: (raw) => gateway.verifyConfirmation(raw),
				cancelIntent: (i) => gateway.cancelIntent(i),
				async refund(input: RefundInput): Promise<RefundResult> {
					return input.providerRef === "pi_3e_a"
						? {
								ok: true,
								refundRef: `re_${input.idempotencyKey}`,
								amount: input.amount,
								currency: input.currency,
							}
						: { ok: false, reason: "RETRYABLE" };
				},
			};
			const later = new Date(Date.parse(h.settleDeps.clock.now().toISOString()) + 3_600_000);
			await retryLatePaymentRefunds({ ...retryDeps(h, flaky), clock: { now: () => later } });

			const refunds = await store.listRefunds(s.order.id);
			expect(refunds.map((r) => r.status).toSorted()).toEqual(["recorded", "reserved"]);
			expect(await store.listRefundRetriesDue("9999-01-01T00:00:00.000Z", 10)).toEqual([
				s.order.id,
			]);
			const retries = (await store.readOrderLedger(s.order.id))?.refundRetries ?? [];
			expect(retries.map((r) => r.idempotencyKey)).toEqual([latePaymentRefundKey("pi_3e_b")]);
		});

		test("a TERMINAL refusal flags 'refund it manually', schedules nothing, and still never says nothing was charged", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedExpiredOrder(h, "4");
			const store = h.settleDeps.orderStore;
			gateway.setRefundResult({ ok: false, reason: "TERMINAL" });

			const res = await settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_4"));

			expect(res.ok).toBe(true);
			const flag = (await state(h, s.order.id)).reconciliationFlag ?? "";
			expect(flag).toContain("automatic refund failed (GATEWAY_TERMINAL)");
			expect(flag).toContain("refund it manually");
			expect((await store.listRefunds(s.order.id)).map((r) => r.status)).toEqual(["voided"]);
			expect(await store.listRefundRetriesDue("9999-01-01T00:00:00.000Z", 10)).toEqual([]);
			expect(await latePayment(h, s.order.id)).toBe("refund_pending");
		});

		test("a resume after the provider ALREADY issued the refund fails closed to 'verify in Stripe' — never a second refund", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedExpiredOrder(h, "5");
			const store = h.settleDeps.orderStore;

			// The provider moved the money; our call died before the ledger heard.
			await expect(
				settleOrder(h.settleDeps, issuesThenCrashes(gateway), succeeded(gateway, s, "evt_5")),
			).rejects.toThrow();
			expect((await store.listRefunds(s.order.id)).map((r) => r.status)).toEqual(["reserved"]);

			// The redelivery's resume meets the provider's own view — already refunded —
			// exactly as the real Stripe pre-flight would report it.
			gateway.setRefundResult({ ok: false, reason: "PROVIDER_ALREADY_REFUNDED" });
			const res = await settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_5"));

			expect(res.ok).toBe(true);
			const flag = (await state(h, s.order.id)).reconciliationFlag ?? "";
			expect(flag).toContain("verify in Stripe");
			expect(flag).toContain("may already be refunded");
			expect((await store.listRefunds(s.order.id)).map((r) => r.status)).toEqual(["unverified"]);
			expect(
				gateway.refundCalls.filter((c) => c.idempotencyKey !== latePaymentRefundKey(s.intentId)),
			).toEqual([]);
		});

		test("a gateway that cannot refund keeps the manual flag — but the capture is recorded, so the order never reads 'nothing charged'", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe", refundable: false });
			const s = await seedExpiredOrder(h, "6");
			const store = h.settleDeps.orderStore;
			const now = h.settleDeps.clock.now().toISOString();
			await drainNotices(store, s.order.id, now);

			const res = await settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_6"));

			expect(res.ok).toBe(true);
			expect(gateway.refundCalls).toHaveLength(0);
			const after = await state(h, s.order.id);
			expect(after.state).toBe("expired");
			expect(after.reconciliationFlag).not.toBeNull();
			expect(await store.getCapturedPayments(s.order.id)).toHaveLength(1);
			expect(await latePayment(h, s.order.id)).not.toBe("none");
			expect(await drainNotices(store, s.order.id, now)).toEqual([]);
		});

		test("a redelivered success on an order that WAS paid and then cancelled is never auto-refunded", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedPendingOrder(h, "7");
			await settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_7"));
			const cancelled = await cancelOrder(
				{ orderStore: h.settleDeps.orderStore },
				{
					orderId: s.order.id,
					reason: "customer_request",
					cancelledBy: "admin",
					idempotencyKey: idempotencyKey("cancel-7"),
				},
			);
			expect(cancelled.ok).toBe(true);

			const res = await settleOrder(h.settleDeps, gateway, succeeded(gateway, s, "evt_7"));

			expect(res.ok).toBe(true);
			expect(gateway.refundCalls).toHaveLength(0);
			expect(await latePayment(h, s.order.id), "the order's own payment, not a late one").toBe(
				"none",
			);
		});

		test("a CANCELLED order with no audit trail (it predates the log) is never auto-refunded — no evidence it was unpaid", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			await h.seedOrderWithoutAudit({
				id: "ord-late-legacy",
				state: "cancelled",
				currency: "USD",
				buyerRef: "legacy@example.com",
				paymentMethod: "stripe",
				createdAt: "2026-01-01T00:00:00.000Z",
				totalCents: TOTAL_CENTS,
			});

			const res = await settleOrder(
				h.settleDeps,
				gateway,
				gateway.webhook({
					outcome: "succeeded",
					orderId: "ord-late-legacy",
					providerRef: "pi_legacy",
					amount: TOTAL_CENTS,
					currency: "USD",
					dedupeKey: "evt_legacy",
				}),
			);

			expect(res.ok).toBe(true);
			expect(gateway.refundCalls).toHaveLength(0);
			expect((await state(h, orderId("ord-late-legacy"))).reconciliationFlag).not.toBeNull();
			// The money is still on the ledger for the human who decides.
			expect(
				await h.settleDeps.orderStore.getCapturedPayments(orderId("ord-late-legacy")),
			).toHaveLength(1);
		});
	});
}
