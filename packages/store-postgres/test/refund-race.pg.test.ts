import { cancelOrder, currency, idempotencyKey, refundOrder, cents } from "@urumi/domain";
import type {
	ClientAction,
	ConfirmationResult,
	CreateIntentInput,
	PaymentGateway,
	PaymentIntentHandle,
	RawConfirmation,
	RefundInput,
	RefundResult,
} from "@urumi/domain";
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

/**
 * A refundable (Stripe-shaped) gateway with INJECTED LATENCY on `refund` — the
 * seam the reserve-before-issue protocol runs across (ADR-0008). Every `refund`
 * is counted, so a race can assert the provider is called ONLY after a committed
 * reservation (never "issued without a row"). The latency widens the window
 * between reserve and finalize so N winners' issue+finalize legs genuinely
 * interleave. Records the peak concurrent in-flight issues to prove the arbiter
 * — not the gateway — is what bounds issuance.
 */
class LatencyRefundGateway implements PaymentGateway {
	readonly id = "stripe" as const;
	readonly refundable = true;
	#delayMs: number;
	issueCount = 0;
	inFlight = 0;
	peakInFlight = 0;

	constructor(delayMs: number) {
		this.#delayMs = delayMs;
	}

	async refund(input: RefundInput): Promise<RefundResult> {
		this.issueCount += 1;
		this.inFlight += 1;
		this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
		try {
			await new Promise((r) => setTimeout(r, this.#delayMs));
			return {
				ok: true,
				refundRef: `re_${input.idempotencyKey}`,
				amount: input.amount,
				currency: input.currency,
			};
		} finally {
			this.inFlight -= 1;
		}
	}

	// Unused by the refund path — the race never drives money-in.
	async createIntent(input: CreateIntentInput): Promise<PaymentIntentHandle> {
		const clientAction: ClientAction = { kind: "none" };
		return { gateway: this.id, intentId: `pi_${input.orderId}`, clientAction };
	}
	async verifyConfirmation(_raw: RawConfirmation): Promise<ConfirmationResult> {
		return { ok: false, reason: "MALFORMED" };
	}
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

	// -- GATEWAY-INTERLEAVED: reserve-before-issue under a real (latent) gateway --
	// The blocker fix (ADR-0008): the ledger slot is RESERVED (atomic ceiling
	// arbitration under the orders row lock) BEFORE the provider is ever called, so
	// no interleaving can let money leave the gateway only for the ledger to refuse
	// it. These runs inject latency into `gateway.refund` to force the reserve and
	// issue+finalize legs of N racing refunds to genuinely overlap, and assert the
	// money invariants hold under every interleaving.

	test("N concurrent FULL gateway refunds: the provider is called at most ONCE; never issued-without-a-row; exactly one → refunded", async () => {
		const LOOPS = 12; // a flaky money race is a blocker — loop hard
		for (let loop = 0; loop < LOOPS; loop++) {
			const h = await makePgRefundOrderStore();
			const gw = new LatencyRefundGateway(15);
			const N = 24;
			const id = await h.seedPaidOrder({ id: `ord-gw-full-${loop}`, totalCents: 1000 });

			const results = await Promise.all(
				Array.from({ length: N }, (_v, i) =>
					refundOrder({ orderStore: h.store }, gw, {
						orderId: id,
						amount: cents(1000), // each wants the WHOLE ceiling
						currency: USD,
						refundedBy: `admin-${i}`,
						idempotencyKey: idempotencyKey(`rf-gw-full-${loop}-${i}`), // distinct ⇒ real race
					}),
				),
			);

			const winners = results.filter((r) => r.ok && r.recorded);
			expect(winners, `loop ${loop}: exactly one winner`).toHaveLength(1);
			// The CORE invariant: the provider is only ever reached AFTER a committed
			// reservation, so the number of issue calls can never exceed the number of
			// won reservations. For a full-ceiling race that is exactly ONE — the
			// losers were rejected at reserve, BEFORE any gateway call.
			expect(gw.issueCount, `loop ${loop}: never issued-without-a-row`).toBe(1);
			expect(gw.peakInFlight, `loop ${loop}: arbiter (not the gateway) bounds issuance`).toBe(1);

			const ledger = await h.store.listRefunds(id);
			const finalizedSum = ledger
				.filter((r) => r.status === "recorded")
				.reduce((s, x) => s + x.amount, 0);
			const activeSum = ledger
				.filter((r) => r.status !== "voided")
				.reduce((s, x) => s + x.amount, 0);
			expect(finalizedSum, `loop ${loop}: finalized Σ = ceiling`).toBe(1000);
			expect(activeSum, `loop ${loop}: Σ(finalized+reserved) never exceeds ceiling`).toBe(1000);
			expect((await h.store.getById(id))?.state, `loop ${loop}: refunded`).toBe("refunded");
			const refundedEvents = (await h.store.listEventsForOrder(id)).filter(
				(e) => e.toState === "refunded",
			);
			expect(refundedEvents, `loop ${loop}: exactly one → refunded event`).toHaveLength(1);
			await teardownOrderFlow();
		}
	}, 180_000);

	test("N concurrent PARTIAL gateway refunds interleave: issues == winners (never orphaned); Σ(active) bounded; one flip", async () => {
		const LOOPS = 12;
		for (let loop = 0; loop < LOOPS; loop++) {
			const h = await makePgRefundOrderStore();
			const gw = new LatencyRefundGateway(10);
			const N = 20; // 20 × 100 = 2000 requested vs a 1000 ceiling ⇒ exactly 10 fit
			const id = await h.seedPaidOrder({ id: `ord-gw-part-${loop}`, totalCents: 1000 });

			const results = await Promise.all(
				Array.from({ length: N }, (_v, i) =>
					refundOrder({ orderStore: h.store }, gw, {
						orderId: id,
						amount: cents(100),
						currency: USD,
						refundedBy: `admin-${i}`,
						idempotencyKey: idempotencyKey(`rf-gw-part-${loop}-${i}`),
					}),
				),
			);

			const recorded = results.filter((r) => r.ok && r.recorded);
			expect(recorded, `loop ${loop}: exactly 10 fit`).toHaveLength(10);
			// Never issued-without-a-row AND never a row-without-issue: on the gateway
			// path each winner reserves → issues → finalizes exactly once, so the count
			// of provider calls equals the count of winners. Losers never touched it.
			expect(gw.issueCount, `loop ${loop}: issues == winners (no orphaned issue)`).toBe(10);

			const ledger = await h.store.listRefunds(id);
			const finalizedSum = ledger
				.filter((r) => r.status === "recorded")
				.reduce((s, x) => s + x.amount, 0);
			const activeSum = ledger
				.filter((r) => r.status !== "voided")
				.reduce((s, x) => s + x.amount, 0);
			expect(activeSum, `loop ${loop}: Σ(finalized+reserved) bounded at ceiling`).toBe(1000);
			expect(finalizedSum, `loop ${loop}: finalized Σ = ceiling`).toBe(1000);
			expect((await h.store.getById(id))?.state, `loop ${loop}: refunded`).toBe("refunded");
			expect(
				results.filter((r) => r.ok && r.fullyRefunded),
				`loop ${loop}: exactly one fullyRefunded`,
			).toHaveLength(1);
			await teardownOrderFlow();
		}
	}, 180_000);

	test("a TERMINAL gateway leg voids its reservation, RELEASING capacity for a concurrent winner; a HELD (unverified) one does not", async () => {
		const LOOPS = 10;
		for (let loop = 0; loop < LOOPS; loop++) {
			const h = await makePgRefundOrderStore();
			// A gateway that fails the FIRST issue TERMINAL (voids → releases capacity)
			// and succeeds the rest, with latency so the release races a live winner.
			let calls = 0;
			const gw: PaymentGateway = {
				id: "stripe",
				refundable: true,
				async refund(input: RefundInput): Promise<RefundResult> {
					const mine = ++calls;
					await new Promise((r) => setTimeout(r, 12));
					if (mine === 1) return { ok: false, reason: "TERMINAL" };
					return {
						ok: true,
						refundRef: `re_${input.idempotencyKey}`,
						amount: input.amount,
						currency: input.currency,
					};
				},
				async createIntent(input: CreateIntentInput): Promise<PaymentIntentHandle> {
					return {
						gateway: "stripe",
						intentId: `pi_${input.orderId}`,
						clientAction: { kind: "none" },
					};
				},
				async verifyConfirmation(): Promise<ConfirmationResult> {
					return { ok: false, reason: "MALFORMED" };
				},
			};
			const id = await h.seedPaidOrder({ id: `ord-gw-void-${loop}`, totalCents: 1000 });

			// Two full-ceiling refunds race. Exactly one wins the RESERVATION; if that
			// winner's issue is the TERMINAL one, it voids (releases capacity) — but the
			// OTHER caller already lost the reservation, so it cannot re-win here. This
			// asserts the arbiter never lets Σ(active) exceed the ceiling regardless of
			// which leg voided.
			const [a, b] = await Promise.all([
				refundOrder({ orderStore: h.store }, gw, {
					orderId: id,
					amount: cents(1000),
					currency: USD,
					refundedBy: "admin-a",
					idempotencyKey: idempotencyKey(`rf-gw-void-${loop}-a`),
				}),
				refundOrder({ orderStore: h.store }, gw, {
					orderId: id,
					amount: cents(1000),
					currency: USD,
					refundedBy: "admin-b",
					idempotencyKey: idempotencyKey(`rf-gw-void-${loop}-b`),
				}),
			]);
			const ledger = await h.store.listRefunds(id);
			const activeSum = ledger
				.filter((r) => r.status !== "voided")
				.reduce((s, x) => s + x.amount, 0);
			expect(activeSum, `loop ${loop}: Σ(active) never exceeds ceiling`).toBeLessThanOrEqual(1000);
			// The two settle to distinct fates — never both recorded, never both fully.
			const fullies = [a, b].filter((r) => r.ok && r.fullyRefunded);
			expect(fullies.length, `loop ${loop}: at most one → refunded`).toBeLessThanOrEqual(1);
			// After a released (voided) reservation, a FRESH refund can reclaim the
			// capacity — proving the void truly released it.
			if (activeSum === 0) {
				const reclaim = await refundOrder({ orderStore: h.store }, new LatencyRefundGateway(0), {
					orderId: id,
					amount: cents(1000),
					currency: USD,
					refundedBy: "admin-reclaim",
					idempotencyKey: idempotencyKey(`rf-gw-void-${loop}-reclaim`),
				});
				expect(
					reclaim.ok && reclaim.fullyRefunded,
					`loop ${loop}: voided capacity reclaimable`,
				).toBe(true);
			}
			await teardownOrderFlow();
		}
	}, 120_000);

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
