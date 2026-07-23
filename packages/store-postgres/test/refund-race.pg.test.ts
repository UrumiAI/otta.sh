import { cancelOrder, currency, idempotencyKey, refundOrder, cents } from "@urumi/domain";
import { FakePaymentGateway } from "@urumi/domain/testing";
import { afterEach, describe, expect, test } from "vitest";
import { makePgRefundOrderStore, teardownOrderFlow } from "./order-harness.js";

// Money movement under concurrency (Postgres-required, like no-oversell): the
// refunds ledger ceiling `Σ refunds ≤ min(Σ captured, total)` must hold under
// EVERY interleaving of N racing refunds. `recordRefund` locks the order row and
// re-reads the sums inside one transaction, so concurrent refunds serialize and
// none over-shoots. SQLite serializes writes globally, so these can't race there.

const PG = process.env.PG_CONNECTION_STRING;
const USD = currency("USD");

afterEach(teardownOrderFlow);

// A record-only (manual, refundable:false) gateway keeps the race a PURE test of
// the ledger arbiter — no external gateway calls interleave.
function manualGw(): FakePaymentGateway {
	return new FakePaymentGateway({ id: "x402", refundable: false });
}

describe.skipIf(PG === undefined)("refund ceiling under concurrency [postgres]", () => {
	test("N concurrent full refunds (each = ceiling) yield exactly ONE winner; Σ = ceiling; one → refunded event", async () => {
		const h = await makePgRefundOrderStore();
		const gw = manualGw();
		const N = 24;
		const id = await h.seedPaidOrder({ id: "ord-full-race", totalCents: 1000, gateway: "x402" });

		const results = await Promise.all(
			Array.from({ length: N }, (_v, i) =>
				refundOrder({ orderStore: h.store }, gw, {
					orderId: id,
					amount: cents(1000), // each caller wants the WHOLE ceiling
					currency: USD,
					refundedBy: `admin-${i}`,
					idempotencyKey: idempotencyKey(`rf-full-${i}`), // distinct keys ⇒ real race
				}),
			),
		);

		const winners = results.filter((r) => r.ok && r.recorded);
		expect(winners, "exactly one winner").toHaveLength(1);
		// Every loser is a typed ceiling rejection — never a silent success, never a throw.
		for (const r of results) {
			if (!(r.ok && r.recorded)) {
				expect(r.ok).toBe(false);
				if (!r.ok) expect(r.reason).toBe("REFUND_EXCEEDS_TOTAL");
			}
		}
		const ledger = await h.store.listRefunds(id);
		expect(
			ledger.reduce((s, x) => s + x.amount, 0),
			"Σ never exceeds ceiling",
		).toBe(1000);
		expect((await h.store.getById(id))?.state).toBe("refunded");
		const refundedEvents = (await h.store.listEventsForOrder(id)).filter(
			(e) => e.toState === "refunded",
		);
		expect(refundedEvents, "exactly one → refunded audit event").toHaveLength(1);
	}, 60_000);

	test("N concurrent partial refunds are sum-bounded under every interleaving; the ceiling-reaching one flips → refunded", async () => {
		const h = await makePgRefundOrderStore();
		const gw = manualGw();
		const LOOPS = 8;
		for (let loop = 0; loop < LOOPS; loop++) {
			const N = 20; // 20 × 100 = 2000 requested against a 1000 ceiling ⇒ 10 fit
			const id = await h.seedPaidOrder({
				id: `ord-part-${loop}`,
				totalCents: 1000,
				gateway: "x402",
			});
			const results = await Promise.all(
				Array.from({ length: N }, (_v, i) =>
					refundOrder({ orderStore: h.store }, gw, {
						orderId: id,
						amount: cents(100),
						currency: USD,
						refundedBy: `admin-${i}`,
						idempotencyKey: idempotencyKey(`rf-part-${loop}-${i}`),
					}),
				),
			);
			const recorded = results.filter((r) => r.ok && r.recorded);
			const ledger = await h.store.listRefunds(id);
			const sum = ledger.reduce((s, x) => s + x.amount, 0);
			expect(sum, `loop ${loop}: Σ bounded at ceiling`).toBe(1000);
			expect(recorded, `loop ${loop}: exactly 10 fit`).toHaveLength(10);
			// The one that reached the ceiling flipped the order — exactly one → refunded.
			expect((await h.store.getById(id))?.state, `loop ${loop}: refunded`).toBe("refunded");
			expect(
				results.filter((r) => r.ok && r.fullyRefunded),
				`loop ${loop}: exactly one fullyRefunded`,
			).toHaveLength(1);
		}
	}, 120_000);

	test("a same-key replay under concurrency records exactly once (no second row)", async () => {
		const h = await makePgRefundOrderStore();
		const gw = manualGw();
		const N = 16;
		const id = await h.seedPaidOrder({ id: "ord-idem-race", totalCents: 1000, gateway: "x402" });
		const key = idempotencyKey("rf-idem-race");
		const results = await Promise.all(
			Array.from({ length: N }, (_v, i) =>
				refundOrder({ orderStore: h.store }, gw, {
					orderId: id,
					amount: cents(400),
					currency: USD,
					refundedBy: `admin-${i}`,
					idempotencyKey: key, // SAME key ⇒ once-only
				}),
			),
		);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(
			results.filter((r) => r.ok && r.recorded),
			"recorded exactly once",
		).toHaveLength(1);
		const ledger = await h.store.listRefunds(id);
		expect(ledger, "one ledger row").toHaveLength(1);
		expect(ledger[0]?.amount).toBe(400);
	}, 60_000);

	test("refund-vs-cancel: the order is never BOTH refunded and cancelled; Σ stays bounded", async () => {
		const h = await makePgRefundOrderStore();
		const gw = manualGw();
		const LOOPS = 10;
		for (let loop = 0; loop < LOOPS; loop++) {
			const id = await h.seedPaidOrder({ id: `ord-vs-${loop}`, totalCents: 1000, gateway: "x402" });
			const [refund, cancel] = await Promise.all([
				refundOrder({ orderStore: h.store }, gw, {
					orderId: id,
					amount: cents(1000), // a FULL refund → would flip to refunded
					currency: USD,
					refundedBy: "refunder",
					idempotencyKey: idempotencyKey(`rf-vs-${loop}`),
				}),
				cancelOrder(
					{ orderStore: h.store },
					{
						orderId: id,
						reason: "customer_request",
						cancelledBy: "canceller",
						idempotencyKey: idempotencyKey(`cx-vs-${loop}`),
					},
				),
			]);
			const state = (await h.store.getById(id))?.state;
			// The order settles on exactly ONE terminal state — never a torn "both".
			expect(["refunded", "cancelled", "paid"], `loop ${loop}`).toContain(state);
			const sum = (await h.store.listRefunds(id)).reduce((s, x) => s + x.amount, 0);
			expect(sum, `loop ${loop}: Σ bounded`).toBeLessThanOrEqual(1000);
			// If the cancel won the state, the refund never flipped to refunded.
			if (state === "cancelled") expect(refund.ok && refund.fullyRefunded).not.toBe(true);
			if (state === "refunded") expect(cancel.ok && cancel.cancelled).not.toBe(true);
		}
	}, 120_000);
});
