import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import { idempotencyKey, orderId, productId, reservationId, sku } from "../money/ids.js";
import type { OrderId } from "../money/ids.js";
import { cancelDueIntents } from "../orders/cancel-due-intents.js";
import { cancelOrder } from "../orders/cancel-order.js";
import { expireOrders } from "../orders/expire-orders.js";
import type { Order } from "../orders/model.js";
import { settleOrder } from "../orders/settle-order.js";
import type { PaymentIntentRecord } from "../ports/order-store.js";
import { FakePaymentGateway } from "./fake-payment-gateway.js";
import type { PaymentDeclineHarness } from "./payment-decline-contract.js";

const USD = currency("USD");
const TOTAL_CENTS = 1500;
const HOLD_MS = 15 * 60 * 1000;
const MINUTE = 60_000;

/** The intent-cancel spec runs on the decline spec's harness (shared stores). */
export type IntentCancelHarness = PaymentDeclineHarness;

export interface IntentCancelContractOptions {
	dialect: string;
}

interface Seeded {
	order: Order;
	intentId: string;
	holdExpiresAt: Date;
}

/** A pending order holding one unit, with its checkout's intent RECORDED. */
async function seedPendingOrder(h: IntentCancelHarness, n: string): Promise<Seeded> {
	const { inventoryStore, orderStore, clock } = h.settleDeps;
	const now = clock.now();
	const holdExpiresAt = new Date(now.getTime() + HOLD_MS);
	const skuStr = `SKU-IC-${n}`;
	const oid = orderId(`ord-ic-${n}`);
	await inventoryStore.seedOnHand(skuStr, 3);
	const heldId = await h.holdForCheckout(skuStr, 1, `ic-res-${n}`, holdExpiresAt.toISOString());
	const created = await orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`ic-order-${n}`),
		holdExpiresAt: holdExpiresAt.toISOString(),
		buyerRef: `buyer-${n}@example.com`,
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId(`p-ic-${n}`),
				sku: sku(skuStr),
				title: "Widget",
				unitPrice: cents(TOTAL_CENTS),
				currency: USD,
				quantity: 1,
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
	const intentId = `pi_ic_${n}`;
	await orderStore.recordPaymentIntent({ orderId: oid, gateway: "stripe", intentId });
	return { order: created.order, intentId, holdExpiresAt };
}

function at(s: Seeded, offsetMs: number): Date {
	return new Date(s.holdExpiresAt.getTime() + offsetMs);
}

/** Run the sweep's leg at `now`, through `gateway` (resolved lazily). */
function sweep(
	h: IntentCancelHarness,
	gateway: FakePaymentGateway,
	now: Date,
	options: Parameters<typeof cancelDueIntents>[1] = {},
) {
	return cancelDueIntents(
		{
			orderStore: h.settleDeps.orderStore,
			clock: { now: () => now },
			gateways: () => ({ stripe: gateway }),
		},
		options,
	);
}

async function intentOf(h: IntentCancelHarness, id: OrderId): Promise<PaymentIntentRecord> {
	const [intent] = await h.settleDeps.orderStore.listPaymentIntents(id);
	if (intent === undefined) throw new Error(`no intent on ${id}`);
	return intent;
}

/**
 * LATE-PAYMENT PREVENTION. A checkout records the intent it minted; from the
 * order's hold deadline that intent is DUE for withdrawal unless the order was
 * paid. The intent-cancel sweep drains due intents in its own bounded leg — never
 * inside the expiry, so a provider stall can never hold stock hostage — cancels
 * them once for an order that left `pending` unpaid, reschedules a transient
 * failure a bounded number of times, and leaves the late-payment refund as the
 * backstop for every race it loses.
 */
export function intentCancelContract(
	makeHarness: () => IntentCancelHarness | Promise<IntentCancelHarness>,
	opts: IntentCancelContractOptions,
): void {
	describe(`intentCancelContract [${opts.dialect}]`, () => {
		test("an intent is due at the order's hold; once the order expires the sweep cancels it — once", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedPendingOrder(h, "1");
			expect((await intentOf(h, s.order.id)).cancelDueAt).toBe(s.holdExpiresAt.toISOString());

			expect(await sweep(h, gateway, at(s, -MINUTE)), "not due before the hold").toBe(0);
			expect(await expireOrders(h.expireDeps, at(s, MINUTE))).toBe(1);
			expect(await sweep(h, gateway, at(s, MINUTE))).toBe(1);
			expect(await sweep(h, gateway, at(s, 2 * MINUTE)), "resolved: never asked again").toBe(0);

			expect(gateway.cancelCalls.map((c) => [c.orderId, c.intentId])).toEqual([
				[s.order.id, s.intentId],
			]);
			const intent = await intentOf(h, s.order.id);
			expect(intent.cancelOutcome).toBe("cancelled");
			expect(intent.cancelDueAt).toBeNull();
		});

		test("a PAID order's intent never becomes due — the paid flip resolves it", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedPendingOrder(h, "2");
			const paid = await settleOrder(
				h.settleDeps,
				gateway,
				gateway.webhook({
					outcome: "succeeded",
					orderId: s.order.id,
					providerRef: s.intentId,
					amount: TOTAL_CENTS,
					currency: "USD",
					dedupeKey: "evt_ic_2",
				}),
			);
			expect(paid.ok).toBe(true);

			expect(await sweep(h, gateway, at(s, 60 * MINUTE))).toBe(0);
			expect(gateway.cancelCalls).toHaveLength(0);
			const intent = await intentOf(h, s.order.id);
			expect(intent.cancelOutcome).toBe("not_needed");
			expect(intent.cancelDueAt).toBeNull();
		});

		test("cancelling an UNPAID order makes its intent due at once, before the hold", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedPendingOrder(h, "3");
			const res = await cancelOrder(
				{ orderStore: h.settleDeps.orderStore },
				{
					orderId: s.order.id,
					reason: "customer_request",
					cancelledBy: "admin",
					idempotencyKey: idempotencyKey("ic-cancel-3"),
				},
			);
			expect(res.ok).toBe(true);

			// Well before the hold deadline.
			expect(await sweep(h, gateway, at(s, -10 * MINUTE))).toBe(1);
			expect(gateway.cancelCalls.map((c) => c.intentId)).toEqual([s.intentId]);
		});

		test("a pending order past its hold is withdrawn AT THE DEADLINE, whether or not the expiry has reached it", async () => {
			// QA2 M1a: the cancel used to be pushed back while the expiry lagged, so the
			// order expired with its intent still payable. Withdrawal no longer waits
			// for the expiry: past the hold the order can no longer be paid, so the
			// intent goes at once — and the order stays `pending` until the expiry
			// releases its stock, exactly as before.
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedPendingOrder(h, "4");

			expect(await sweep(h, gateway, at(s, 0)), "due exactly at the hold").toBe(1);

			expect(gateway.cancelCalls.map((c) => c.intentId)).toEqual([s.intentId]);
			const intent = await intentOf(h, s.order.id);
			expect(intent.cancelOutcome).toBe("cancelled");
			expect(intent.cancelDueAt).toBeNull();
			expect((await h.settleDeps.orderStore.getById(s.order.id))?.state).toBe("pending");

			expect(await expireOrders(h.expireDeps, at(s, 5 * MINUTE))).toBe(1);
			expect(await sweep(h, gateway, at(s, 6 * MINUTE)), "withdrawn once, never again").toBe(0);
			expect(gateway.cancelCalls).toHaveLength(1);
		});

		test("a payment that lands between the deadline and the expiry (the cancel lost the race) is ACCEPTED: the stock was still held", async () => {
			// ADR-0022 (2026-10-03 amendment): a payment confirmed before the withdrawal
			// reached the provider settles a still-pending order normally — its adopted
			// stock is still held, so nothing is oversold. Only after the expiry is a
			// payment late (and refunded).
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			gateway.setCancelResult({ ok: true, outcome: "not_cancellable" });
			const s = await seedPendingOrder(h, "4b");

			await sweep(h, gateway, at(s, 30_000));
			expect((await intentOf(h, s.order.id)).cancelOutcome).toBe("not_cancellable");

			const settled = await settleOrder(
				{ ...h.settleDeps, clock: { now: () => at(s, 40_000) } },
				gateway,
				gateway.webhook({
					outcome: "succeeded",
					orderId: s.order.id,
					providerRef: s.intentId,
					amount: TOTAL_CENTS,
					currency: "USD",
					dedupeKey: "evt_ic_4b",
				}),
			);
			expect(settled.ok).toBe(true);
			expect((await h.settleDeps.orderStore.getById(s.order.id))?.state).toBe("paid");
			expect(
				await expireOrders(h.expireDeps, at(s, 5 * MINUTE)),
				"a paid order never expires",
			).toBe(0);
		});

		test("each cancel ATTEMPT carries its own idempotency key — a provider replays a saved failure for a reused key", async () => {
			// Stripe saves the first result for a key, failures included, and answers
			// every replay with it: a retry under the same key would only ever see the
			// first attempt's 500 again. A repeat cancel is harmless (cancelling a
			// cancelled intent changes nothing), so each attempt gets a fresh key.
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			gateway.setCancelResult({ ok: false, reason: "RETRYABLE" });
			const s = await seedPendingOrder(h, "4c");

			let now = at(s, MINUTE);
			for (let i = 0; i < 3; i++) {
				await sweep(h, gateway, now);
				now = new Date(now.getTime() + 60 * MINUTE);
			}

			const keys = gateway.cancelCalls.map((c) => String(c.idempotencyKey));
			expect(keys).toHaveLength(3);
			expect(new Set(keys).size).toBe(3);
			expect(keys[0]).toBe(`cancel-intent:${s.intentId}`);
		});

		test("a RETRYABLE (or throwing) cancel is retried by the sweep, a bounded number of times, then given up", async () => {
			for (const failure of ["retryable", "throws"] as const) {
				const h = await makeHarness();
				const gateway = new FakePaymentGateway({ id: "stripe" });
				gateway.setCancelResult(
					failure === "retryable"
						? { ok: false, reason: "RETRYABLE" }
						: new Error("api.stripe.com unreachable"),
				);
				const s = await seedPendingOrder(h, `5${failure}`);
				await expireOrders(h.expireDeps, at(s, MINUTE));

				let now = at(s, MINUTE);
				for (let i = 0; i < 10; i++) {
					await sweep(h, gateway, now, { maxAttempts: 3 });
					now = new Date(now.getTime() + 60 * MINUTE);
				}

				expect(gateway.cancelCalls, failure).toHaveLength(3);
				const intent = await intentOf(h, s.order.id);
				expect(intent.cancelOutcome, failure).toBe("failed");
				expect(intent.cancelAttempts, failure).toBe(3);
				expect((await h.settleDeps.orderStore.getById(s.order.id))?.state, failure).toBe("expired");
			}
		});

		test("a TERMINAL refusal is given up at once; not_cancellable and UNSUPPORTED resolve quietly", async () => {
			const h = await makeHarness();
			const cases = [
				[{ ok: false, reason: "TERMINAL" }, "failed"],
				[{ ok: true, outcome: "not_cancellable" }, "not_cancellable"],
				[{ ok: false, reason: "UNSUPPORTED" }, "unsupported"],
			] as const;
			for (const [i, [result, outcome]] of cases.entries()) {
				const gateway = new FakePaymentGateway({ id: "stripe" });
				gateway.setCancelResult(result);
				const s = await seedPendingOrder(h, `6-${String(i)}`);
				await expireOrders(h.expireDeps, at(s, MINUTE));
				await sweep(h, gateway, at(s, MINUTE));
				expect((await intentOf(h, s.order.id)).cancelOutcome, outcome).toBe(outcome);
				expect(gateway.cancelCalls, outcome).toHaveLength(1);
			}
		});

		test("giving up FLAGS the order for reconciliation, naming the intent — once, and never over an existing flag", async () => {
			// QA2 follow-up: a give-up was only a log line. The refund still backstops
			// a payment on the intent, but an admin should see that the intent may be
			// payable, so the order is flagged (the badge on the orders console).
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			gateway.setCancelResult({ ok: false, reason: "TERMINAL" });
			const s = await seedPendingOrder(h, "9");
			await expireOrders(h.expireDeps, at(s, MINUTE));

			await sweep(h, gateway, at(s, MINUTE));

			const flag = (await h.settleDeps.orderStore.getById(s.order.id))?.reconciliationFlag ?? "";
			expect(flag).toContain(s.intentId);
			expect(flag).toMatch(/refunded automatically/);

			// An order already flagged for something else keeps ITS flag.
			const other = await seedPendingOrder(h, "9b");
			await expireOrders(h.expireDeps, at(other, MINUTE));
			await h.settleDeps.orderStore.flagReconciliation(other.order.id, "an earlier anomaly");
			await sweep(h, gateway, at(other, MINUTE));
			expect((await h.settleDeps.orderStore.getById(other.order.id))?.reconciliationFlag).toBe(
				"an earlier anomaly",
			);
		});

		test("a cancel the caller has no time for is NOT started and NOT counted — the intent stays due, its attempts unchanged", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const s = await seedPendingOrder(h, "8");
			await expireOrders(h.expireDeps, at(s, MINUTE));

			await sweep(h, gateway, at(s, MINUTE), { canStartCancel: () => false });

			expect(gateway.cancelCalls).toHaveLength(0);
			const intent = await intentOf(h, s.order.id);
			expect(intent.cancelAttempts).toBe(0);
			expect(intent.cancelOutcome).toBeNull();
			expect((intent.cancelDueAt ?? "") <= at(s, MINUTE).toISOString()).toBe(true);
		});

		test("the sweep is BOUNDED (batch limit, shouldContinue) and resolves no gateways when nothing is due", async () => {
			const h = await makeHarness();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			let resolved = 0;
			const deps = (now: Date) => ({
				orderStore: h.settleDeps.orderStore,
				clock: { now: () => now },
				gateways: () => {
					resolved++;
					return { stripe: gateway };
				},
			});
			expect(await cancelDueIntents(deps(new Date("2000-01-01T00:00:00.000Z")))).toBe(0);
			expect(resolved, "a quiet tick reads no secrets").toBe(0);

			const seeded = [
				await seedPendingOrder(h, "7a"),
				await seedPendingOrder(h, "7b"),
				await seedPendingOrder(h, "7c"),
			];
			const later = at(seeded[0]!, MINUTE);
			await expireOrders(h.expireDeps, later);

			expect(await cancelDueIntents(deps(later), { limit: 2 })).toBe(2);
			let budget = 1;
			expect(await cancelDueIntents(deps(later), { shouldContinue: () => budget-- > 0 })).toBe(1);
			expect(gateway.cancelCalls).toHaveLength(3);
		});
	});
}
