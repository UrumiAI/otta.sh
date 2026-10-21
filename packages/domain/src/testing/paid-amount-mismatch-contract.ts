import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import { idempotencyKey, orderId, productId, reservationId, sku } from "../money/ids.js";
import type { OrderId } from "../money/ids.js";
import type { Order } from "../orders/model.js";
import { settleOrder } from "../orders/settle-order.js";
import { FakePaymentGateway } from "./fake-payment-gateway.js";
import type { PaymentDeclineHarness } from "./payment-decline-contract.js";

const USD = currency("USD");
const ON_HAND = 5;
const QTY = 1;
const TOTAL_CENTS = 1200;
const HOLD_MS = 15 * 60 * 1000;

/** One recorded anomaly, as any adapter family can read it back. */
export interface PaidAmountMismatchAnomaly {
	orderId: string;
	kind: string;
	detail: string;
}

/**
 * The decline spec's harness — one adapter family's real stores, shared between
 * settle and expiry — plus the two things the ports cannot give a spec: a way to
 * move the shared clock (so a replay lands at a DIFFERENT instant, which is what a
 * gateway redelivery does), and a read of the anomalies the payment-event store
 * recorded. The port is write-only for anomalies on purpose (the record IS the alert
 * seam); reading them is an operator's concern, so each family supplies its own.
 */
export interface PaidAmountMismatchHarness extends PaymentDeclineHarness {
	advanceClock(ms: number): void;
	anomalies(): Promise<PaidAmountMismatchAnomaly[]>;
}

export interface PaidAmountMismatchContractOptions {
	dialect: string;
}

/** A pending PHYSICAL order holding `QTY` units, built through the ports alone. */
async function seedPendingOrder(h: PaidAmountMismatchHarness, n: string): Promise<Order> {
	const { inventoryStore, orderStore, clock } = h.settleDeps;
	const now = clock.now();
	const holdExpiresAt = new Date(now.getTime() + HOLD_MS).toISOString();
	const skuStr = `SKU-PAIDMM-${n}`;
	const oid = orderId(`ord-paidmm-${n}`);

	await inventoryStore.seedOnHand(skuStr, ON_HAND);
	const heldId = await h.holdForCheckout(skuStr, QTY, `paidmm-res-${n}`, holdExpiresAt);
	const created = await orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`paidmm-order-${n}`),
		holdExpiresAt,
		buyerRef: `buyer-${n}@example.com`,
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId(`p-paidmm-${n}`),
				sku: sku(skuStr),
				title: "Widget",
				unitPrice: cents(TOTAL_CENTS),
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
		holdExpiresAt,
		now: now.toISOString(),
	});
	if (!adopted.ok) throw new Error(`seed adopt failed: ${adopted.reason}`);
	return created.order;
}

async function state(h: PaidAmountMismatchHarness, id: OrderId): Promise<Order> {
	const order = await h.settleDeps.orderStore.getById(id);
	if (order === null) throw new Error(`order ${id} vanished`);
	return order;
}

async function anomaliesOf(h: PaidAmountMismatchHarness, id: OrderId, kind: string) {
	return (await h.anomalies()).filter((a) => a.orderId === id && a.kind === kind);
}

/**
 * A STRAY WRONG-AMOUNT SUCCESS ON AN ALREADY-PAID ORDER (issue #35). The terminal
 * short-circuit (review G6) correctly refuses to call it an `AMOUNT_MISMATCH` — the
 * order settled at the right amount — and correctly re-drives nothing. But a
 * verified confirmation for a different amount against a settled order is still a
 * fact an operator may need, so it is kept in the forensic trail as the low-severity
 * `PAID_AMOUNT_MISMATCH` anomaly: recorded once per gateway event (a redelivery of
 * the same event, at a later instant, adds nothing), and moving no state at all.
 */
export function paidAmountMismatchContract(
	makeHarness: () => PaidAmountMismatchHarness | Promise<PaidAmountMismatchHarness>,
	opts: PaidAmountMismatchContractOptions,
): void {
	describe(`paidAmountMismatchContract [${opts.dialect}]`, () => {
		const gateway = new FakePaymentGateway({ id: "stripe" });

		/** A verified success. By default it names the order's OWN PaymentIntent — the
		 *  one the seed settle captured; `providerRef` names a different one. */
		function event(
			order: Order,
			amount: number,
			dedupeKey: string,
			currencyCode = "USD",
			providerRef = `pi_${order.id}`,
		) {
			return gateway.webhook({
				outcome: "succeeded",
				orderId: order.id,
				providerRef,
				amount,
				currency: currencyCode,
				dedupeKey,
			});
		}

		async function paidOrder(h: PaidAmountMismatchHarness, n: string): Promise<Order> {
			const order = await seedPendingOrder(h, n);
			const paid = await settleOrder(
				h.settleDeps,
				gateway,
				event(order, TOTAL_CENTS, `evt_ok_${n}`),
			);
			if (!paid.ok || paid.noop) throw new Error("seed settle failed");
			return order;
		}

		test("a stray mismatched success on a paid order records ONE low-severity PAID_AMOUNT_MISMATCH and moves nothing", async () => {
			const h = await makeHarness();
			const order = await paidOrder(h, "1");
			const before = await state(h, order.id);

			const res = await settleOrder(h.settleDeps, gateway, event(order, 1, "evt_stray_1"));

			expect(res.ok).toBe(true);
			if (res.ok) expect(res.noop).toBe(true);
			const found = await anomaliesOf(h, order.id, "PAID_AMOUNT_MISMATCH");
			expect(found).toHaveLength(1);
			expect(found[0]?.detail).toContain("got 1 USD");
			expect(found[0]?.detail).toContain(`expected ${String(TOTAL_CENTS)} USD`);
			expect(found[0]?.detail).toContain("evt_stray_1");
			// Never the settle-refusing anomaly: the order settled at the right amount.
			expect(await anomaliesOf(h, order.id, "AMOUNT_MISMATCH")).toEqual([]);

			const after = await state(h, order.id);
			expect(after.state).toBe("paid");
			expect(after.reconciliationFlag, "low severity: no manual reconciliation").toBeNull();
			expect(after.totals).toEqual(before.totals);
			expect(await h.settleDeps.orderStore.getCapturedPayments(order.id)).toHaveLength(1);
			expect(await h.settleDeps.inventoryStore.getOnHand(`SKU-PAIDMM-1`)).toBe(ON_HAND - QTY);
		});

		test("a same-amount stray in a DIFFERENT currency is a mismatch too: one PAID_AMOUNT_MISMATCH, nothing moved", async () => {
			const h = await makeHarness();
			const order = await paidOrder(h, "eur");

			const res = await settleOrder(
				h.settleDeps,
				gateway,
				event(order, TOTAL_CENTS, "evt_stray_eur", "EUR"),
			);

			expect(res.ok).toBe(true);
			if (res.ok) expect(res.noop).toBe(true);
			const found = await anomaliesOf(h, order.id, "PAID_AMOUNT_MISMATCH");
			expect(found).toHaveLength(1);
			expect(found[0]?.detail).toContain(`got ${String(TOTAL_CENTS)} EUR`);
			const after = await state(h, order.id);
			expect(after.state).toBe("paid");
			expect(after.reconciliationFlag).toBeNull();
			expect(await h.settleDeps.orderStore.getCapturedPayments(order.id)).toHaveLength(1);
		});

		test("a stray naming a payment this order NEVER captured is a double charge: anomaly AND reconciliation flag, once", async () => {
			const h = await makeHarness();
			const order = await paidOrder(h, "dbl");

			for (let delivery = 0; delivery < 2; delivery++) {
				h.advanceClock(60_000);
				const res = await settleOrder(
					h.settleDeps,
					gateway,
					event(order, 1, "evt_stray_dbl", "USD", "pi_second_intent"),
				);
				expect(res.ok, `delivery ${String(delivery)}`).toBe(true);
				if (res.ok) expect(res.noop).toBe(true);
			}

			const found = await anomaliesOf(h, order.id, "PAID_AMOUNT_MISMATCH");
			expect(found).toHaveLength(1);
			expect(found[0]?.detail).toContain("pi_second_intent");
			expect(found[0]?.detail).toContain("possible double charge");
			const after = await state(h, order.id);
			expect(after.state, "the flag alerts; it moves no state").toBe("paid");
			expect(after.reconciliationFlag).toContain("possible double charge");
			expect(after.reconciliationFlag).toContain("pi_second_intent");
			// The second charge is NOT folded into this order's ledger: a human decides.
			const captured = await h.settleDeps.orderStore.getCapturedPayments(order.id);
			expect(captured.map((p) => p.providerRef)).toEqual([`pi_${order.id}`]);
		});

		test("a double-charge stray never overwrites a reconciliation flag already on the order", async () => {
			const h = await makeHarness();
			const order = await paidOrder(h, "preflag");
			await h.settleDeps.orderStore.flagReconciliation(order.id, "operator: checking", {
				expectedFlag: null,
			});

			await settleOrder(
				h.settleDeps,
				gateway,
				event(order, 1, "evt_stray_preflag", "USD", "pi_other_intent"),
			);

			expect((await state(h, order.id)).reconciliationFlag).toBe("operator: checking");
			expect(await anomaliesOf(h, order.id, "PAID_AMOUNT_MISMATCH")).toHaveLength(1);
		});

		test("a redelivery of the SAME stray event, at a later instant, does not duplicate the anomaly", async () => {
			const h = await makeHarness();
			const order = await paidOrder(h, "2");

			for (let delivery = 0; delivery < 3; delivery++) {
				h.advanceClock(60_000);
				const res = await settleOrder(h.settleDeps, gateway, event(order, 1, "evt_stray_2"));
				expect(res.ok, `delivery ${String(delivery)}`).toBe(true);
			}

			expect(await anomaliesOf(h, order.id, "PAID_AMOUNT_MISMATCH")).toHaveLength(1);
			expect((await state(h, order.id)).state).toBe("paid");
		});

		test("each DISTINCT stray event is its own forensic record; a matching redelivery records none", async () => {
			const h = await makeHarness();
			const order = await paidOrder(h, "3");

			await settleOrder(h.settleDeps, gateway, event(order, 1, "evt_stray_3a"));
			h.advanceClock(60_000);
			await settleOrder(h.settleDeps, gateway, event(order, 2, "evt_stray_3b"));
			// The original, matching event redelivered: the crash-window heal, not an anomaly.
			await settleOrder(h.settleDeps, gateway, event(order, TOTAL_CENTS, "evt_ok_3"));
			// A fresh, matching event (webhook-before-redirect): a plain no-op too.
			await settleOrder(h.settleDeps, gateway, event(order, TOTAL_CENTS, "evt_ok_3_late"));

			const found = await anomaliesOf(h, order.id, "PAID_AMOUNT_MISMATCH");
			expect(found.map((a) => a.detail.includes("evt_stray_3a"))).toContain(true);
			expect(found.map((a) => a.detail.includes("evt_stray_3b"))).toContain(true);
			expect(found).toHaveLength(2);
			expect((await h.anomalies()).filter((a) => a.orderId === order.id)).toHaveLength(2);
		});
	});
}
