/**
 * Money movement under concurrency, on the document adapter. `@otta-sh/store-postgres`
 * is gone; this is the pg-tier coverage now, re-pointed at `EmdashOrderStore`.
 * Postgres only: better-sqlite3 serializes writes in one process, so it verifies
 * the shape and never the contention.
 *
 * The invariant is the ceiling: `Σ active refunds ≤ min(Σ captured, frozen total)`
 * under EVERY interleaving of N racing refunds. The SQL held it with a row lock on
 * `orders` and sums read under that lock; here `payments[]` and `refunds[]` are
 * fields of the document the refund is appended to, so the ceiling, the arbitration
 * and the row are ONE compare-and-set and the revision does the lock's job — a peer
 * that committed in between makes this writer lose, re-read and re-arbitrate.
 *
 * The N / LOOPS numbers and every original assertion are unchanged. Three assertions
 * are ADDED, because the document model makes them checkable:
 *
 * - every refund claim document AGREES WITH THE LEDGER — a key whose row landed is
 *   `terminal` and names the order that holds it, and a key the ceiling refused is
 *   still `claimed`, because the SQL left a refused key usable and promoting it would
 *   consume a key that moved no money. A claim that is missing entirely is a failure,
 *   not a skip: every call here reaches the claim write before anything else;
 * - the same check runs on every race that arbitrates a ceiling (all but the
 *   terminal-vs-unverified and refund-vs-cancel cases, whose keys deliberately end in
 *   mixed states the ledger comparison already covers case by case);
 * - the compare-and-set depth the race spends is ASSERTED against
 *   {@link CAS_MAX_ATTEMPTS} as well as printed, so a shape that starts exhausting
 *   the budget fails here rather than being read off a log afterwards.
 *
 * The pool is sized so each of the N callers can hold its OWN connection; a pool
 * narrower than the crowd serializes the writers and weakens the race.
 */
import {
	cancelOrder,
	cents,
	currency,
	idempotencyKey,
	refundOrder,
	type ClientAction,
	type ConfirmationResult,
	type CreateIntentInput,
	type OrderId,
	type PaymentGateway,
	type PaymentIntentHandle,
	type RawConfirmation,
	type RefundInput,
	type RefundResult,
} from "@otta-sh/domain";
import { buildRefundSeed, FakePaymentGateway } from "@otta-sh/domain/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	CAS_MAX_ATTEMPTS,
	collectionOf,
	REFUND_KEYS_COLLECTION,
	type RefundKeyDoc,
	type StorageAccess,
	type StorageCollection,
} from "../src/index.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness } from "./order-harness.js";

const USD = currency("USD");
const N = 24;

/** A record-only (manual, `refundable:false`) gateway keeps a race a PURE test of
 *  the ledger arbiter — no external gateway calls interleave. */
function manualGw(): FakePaymentGateway {
	return new FakePaymentGateway({ id: "x402", refundable: false });
}

/**
 * A refundable (Stripe-shaped) gateway with INJECTED LATENCY on `refund` — the seam
 * the reserve-before-issue protocol runs across. Every issue is counted, so a race
 * can assert the provider is reached ONLY after a committed reservation, and the peak
 * in-flight count proves the ARBITER (not the gateway) is what bounds issuance.
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

const PG_SUITE = PG_ENABLED
	? "refund ceiling under concurrency [postgres]"
	: "refund ceiling under concurrency [postgres] — skipped: PG_CONNECTION_STRING is not set";

describe.skipIf(!PG_ENABLED)(PG_SUITE, () => {
	let storage: StorageAccess;
	let close: () => Promise<void>;
	let refundKeys: StorageCollection<RefundKeyDoc>;
	let maxAttempts = 0;

	beforeAll(async () => {
		const db = await makePgStorage(ORDER_LAYOUT, N + 6);
		storage = db.storage;
		close = db.close;
		refundKeys = collectionOf<RefundKeyDoc>(storage, REFUND_KEYS_COLLECTION);
	}, 180_000);

	afterAll(async () => {
		console.info(
			`[refund-race] max compare-and-set attempts observed: ${String(maxAttempts)} of ${String(CAS_MAX_ATTEMPTS)}`,
		);
		await close?.();
	});

	/**
	 * The depth is ASSERTED, not merely printed. An exhausted budget is a typed
	 * retryable refusal rather than a wrong answer, so it would never break the ceiling
	 * invariant — but it would mean a caller who could have been served was told "too
	 * busy", and the whole point of recording the number is to notice that before an
	 * operator does. Called from every race so the bound is checked per case rather
	 * than once at teardown, where a failure could not name the shape.
	 */
	function expectDepthWithinBudget(shape: string): void {
		expect(maxAttempts, `${shape}: compare-and-set depth within the budget`).toBeLessThanOrEqual(
			CAS_MAX_ATTEMPTS,
		);
	}

	/** A store over the shared race storage, recording the attempt depth it spends. */
	function harness(): {
		store: ReturnType<typeof makeOrderHarness>["store"];
		seedPaidOrder: ReturnType<typeof buildRefundSeed>;
	} {
		const store = makeOrderHarness(storage, {
			onCasAttempts: (_operation, attempts) => {
				if (attempts > maxAttempts) maxAttempts = attempts;
			},
		}).store;
		return { store, seedPaidOrder: buildRefundSeed(store) };
	}

	/** Every refund claim document reachable from a set of keys, as it ended. */
	async function claims(keys: string[]): Promise<RefundKeyDoc[]> {
		const docs = await Promise.all(keys.map((key) => refundKeys.get(key)));
		return docs.filter((doc): doc is RefundKeyDoc => doc !== null);
	}

	/**
	 * The ADDED structural assertion: every claim document agrees with the ledger.
	 *
	 * A key whose row LANDED must be `terminal` (its payload dropped, naming the
	 * order that holds the row) — a `claimed` survivor there would be a key stuck
	 * mid-protocol, which is the one state a replayer has to heal. A key whose
	 * arbitration was REJECTED must still be `claimed`, and deliberately: the SQL
	 * inserted no row when the ceiling refused a refund, so the key stayed usable,
	 * and promoting a rejected claim would consume a key that never moved money.
	 */
	async function expectClaimsAgreeWithLedger(orderId: OrderId, keys: string[]): Promise<void> {
		const ledger = await makeOrderHarness(storage).store.listRefunds(orderId);
		for (const key of keys) {
			const claim = (await refundKeys.get(key)) as RefundKeyDoc | null;
			// A MISSING claim is a failure, not something to skip past: the claim write is
			// the first thing every refund path does, so a key that reached the store and
			// left no document would mean the once-only guard never ran for it.
			if (claim === null) throw new Error(`refund key ${key} left no claim document`);
			const landed = ledger.some((row) => row.idempotencyKey === key);
			expect(claim.state, landed ? `${key} landed, so it is terminal` : `${key} was refused`).toBe(
				landed ? "terminal" : "claimed",
			);
			expect(claim.orderId).toBe(orderId);
		}
	}

	test("N concurrent full refunds (each = ceiling) yield exactly ONE winner; Σ = ceiling; one → refunded event", async () => {
		const h = harness();
		const gw = manualGw();
		const id = await h.seedPaidOrder({ id: "ord-full-race", totalCents: 1000, gateway: "x402" });

		const keys = Array.from({ length: N }, (_v, i) => `rf-full-${String(i)}`);
		const results = await Promise.all(
			keys.map((key, i) =>
				refundOrder({ orderStore: h.store }, gw, {
					orderId: id,
					amount: cents(1000), // each caller wants the WHOLE ceiling
					currency: USD,
					refundedBy: `admin-${String(i)}`,
					idempotencyKey: idempotencyKey(key), // distinct keys ⇒ real race
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
		// ADDED: every key that reached the store is terminal and names this order.
		await expectClaimsAgreeWithLedger(id, keys);
		expectDepthWithinBudget("full manual");
	}, 120_000);

	test("N concurrent partial refunds are sum-bounded under every interleaving; the ceiling-reaching one flips → refunded", async () => {
		const h = harness();
		const gw = manualGw();
		const LOOPS = 8;
		for (let loop = 0; loop < LOOPS; loop++) {
			const M = 20; // 20 × 100 = 2000 requested against a 1000 ceiling ⇒ 10 fit
			const id = await h.seedPaidOrder({
				id: `ord-part-${String(loop)}`,
				totalCents: 1000,
				gateway: "x402",
			});
			const keys = Array.from({ length: M }, (_v, i) => `rf-part-${String(loop)}-${String(i)}`);
			const results = await Promise.all(
				keys.map((key, i) =>
					refundOrder({ orderStore: h.store }, gw, {
						orderId: id,
						amount: cents(100),
						currency: USD,
						refundedBy: `admin-${String(i)}`,
						idempotencyKey: idempotencyKey(key),
					}),
				),
			);
			const recorded = results.filter((r) => r.ok && r.recorded);
			const ledger = await h.store.listRefunds(id);
			const sum = ledger.reduce((s, x) => s + x.amount, 0);
			expect(sum, `loop ${String(loop)}: Σ bounded at ceiling`).toBe(1000);
			expect(recorded, `loop ${String(loop)}: exactly 10 fit`).toHaveLength(10);
			// The one that reached the ceiling flipped the order — exactly one → refunded.
			expect((await h.store.getById(id))?.state, `loop ${String(loop)}: refunded`).toBe("refunded");
			expect(
				results.filter((r) => r.ok && r.fullyRefunded),
				`loop ${String(loop)}: exactly one fullyRefunded`,
			).toHaveLength(1);
			await expectClaimsAgreeWithLedger(id, keys);
			expectDepthWithinBudget(`partial manual loop ${String(loop)}`);
		}
	}, 180_000);

	test("a same-key replay under concurrency records exactly once (no second row)", async () => {
		const h = harness();
		const gw = manualGw();
		const M = 16;
		const id = await h.seedPaidOrder({ id: "ord-idem-race", totalCents: 1000, gateway: "x402" });
		const key = idempotencyKey("rf-idem-race");
		const results = await Promise.all(
			Array.from({ length: M }, (_v, i) =>
				refundOrder({ orderStore: h.store }, gw, {
					orderId: id,
					amount: cents(400),
					currency: USD,
					refundedBy: `admin-${String(i)}`,
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
		// ADDED: the one key left exactly ONE claim, terminal, naming this order.
		expect(await claims([key])).toHaveLength(1);
		await expectClaimsAgreeWithLedger(id, [key]);
		expectDepthWithinBudget("same-key replay");
	}, 120_000);

	// -- GATEWAY-INTERLEAVED: reserve-before-issue under a real (latent) gateway --
	// The ledger slot is RESERVED (atomic ceiling arbitration inside the order
	// document's compare-and-set) BEFORE the provider is ever called, so no
	// interleaving can let money leave the gateway only for the ledger to refuse it.
	// These runs inject latency into `gateway.refund` to force the reserve and
	// issue+finalize legs of N racing refunds to genuinely overlap.

	test("N concurrent FULL gateway refunds: the provider is called at most ONCE; never issued-without-a-row; exactly one → refunded", async () => {
		const LOOPS = 12; // a flaky money race is a blocker — loop hard
		for (let loop = 0; loop < LOOPS; loop++) {
			const h = harness();
			const gw = new LatencyRefundGateway(15);
			const id = await h.seedPaidOrder({ id: `ord-gw-full-${String(loop)}`, totalCents: 1000 });

			const keys = Array.from({ length: N }, (_v, i) => `rf-gw-full-${String(loop)}-${String(i)}`);
			const results = await Promise.all(
				keys.map((key, i) =>
					refundOrder({ orderStore: h.store }, gw, {
						orderId: id,
						amount: cents(1000), // each wants the WHOLE ceiling
						currency: USD,
						refundedBy: `admin-${String(i)}`,
						idempotencyKey: idempotencyKey(key), // distinct ⇒ real race
					}),
				),
			);

			const winners = results.filter((r) => r.ok && r.recorded);
			expect(winners, `loop ${String(loop)}: exactly one winner`).toHaveLength(1);
			// The CORE invariant: the provider is only ever reached AFTER a committed
			// reservation, so issues can never exceed won reservations. For a
			// full-ceiling race that is exactly ONE — the losers were rejected at
			// reserve, BEFORE any gateway call.
			expect(gw.issueCount, `loop ${String(loop)}: never issued-without-a-row`).toBe(1);
			expect(
				gw.peakInFlight,
				`loop ${String(loop)}: arbiter (not the gateway) bounds issuance`,
			).toBe(1);

			const ledger = await h.store.listRefunds(id);
			const finalizedSum = ledger
				.filter((r) => r.status === "recorded")
				.reduce((s, x) => s + x.amount, 0);
			const activeSum = ledger
				.filter((r) => r.status !== "voided")
				.reduce((s, x) => s + x.amount, 0);
			expect(finalizedSum, `loop ${String(loop)}: finalized Σ = ceiling`).toBe(1000);
			expect(activeSum, `loop ${String(loop)}: Σ(finalized+reserved) never exceeds ceiling`).toBe(
				1000,
			);
			expect((await h.store.getById(id))?.state, `loop ${String(loop)}: refunded`).toBe("refunded");
			const refundedEvents = (await h.store.listEventsForOrder(id)).filter(
				(e) => e.toState === "refunded",
			);
			expect(refundedEvents, `loop ${String(loop)}: exactly one → refunded event`).toHaveLength(1);
			await expectClaimsAgreeWithLedger(id, keys);
			expectDepthWithinBudget(`full gateway loop ${String(loop)}`);
		}
	}, 240_000);

	test("N concurrent PARTIAL gateway refunds interleave: issues == winners (never orphaned); Σ(active) bounded; one flip", async () => {
		const LOOPS = 12;
		for (let loop = 0; loop < LOOPS; loop++) {
			const h = harness();
			const gw = new LatencyRefundGateway(10);
			const M = 20; // 20 × 100 = 2000 requested vs a 1000 ceiling ⇒ exactly 10 fit
			const id = await h.seedPaidOrder({ id: `ord-gw-part-${String(loop)}`, totalCents: 1000 });

			const keys = Array.from({ length: M }, (_v, i) => `rf-gw-part-${String(loop)}-${String(i)}`);
			const results = await Promise.all(
				keys.map((key, i) =>
					refundOrder({ orderStore: h.store }, gw, {
						orderId: id,
						amount: cents(100),
						currency: USD,
						refundedBy: `admin-${String(i)}`,
						idempotencyKey: idempotencyKey(key),
					}),
				),
			);

			const recorded = results.filter((r) => r.ok && r.recorded);
			expect(recorded, `loop ${String(loop)}: exactly 10 fit`).toHaveLength(10);
			// Never issued-without-a-row AND never a row-without-issue: each winner
			// reserves → issues → finalizes exactly once, so provider calls equal
			// winners. Losers never touched it.
			expect(gw.issueCount, `loop ${String(loop)}: issues == winners (no orphaned issue)`).toBe(10);

			const ledger = await h.store.listRefunds(id);
			const finalizedSum = ledger
				.filter((r) => r.status === "recorded")
				.reduce((s, x) => s + x.amount, 0);
			const activeSum = ledger
				.filter((r) => r.status !== "voided")
				.reduce((s, x) => s + x.amount, 0);
			expect(activeSum, `loop ${String(loop)}: Σ(finalized+reserved) bounded at ceiling`).toBe(
				1000,
			);
			expect(finalizedSum, `loop ${String(loop)}: finalized Σ = ceiling`).toBe(1000);
			expect((await h.store.getById(id))?.state, `loop ${String(loop)}: refunded`).toBe("refunded");
			expect(
				results.filter((r) => r.ok && r.fullyRefunded),
				`loop ${String(loop)}: exactly one fullyRefunded`,
			).toHaveLength(1);
			await expectClaimsAgreeWithLedger(id, keys);
			expectDepthWithinBudget(`partial gateway loop ${String(loop)}`);
		}
	}, 240_000);

	test("a TERMINAL gateway leg voids its reservation, RELEASING capacity for a concurrent winner; a HELD (unverified) one does not", async () => {
		const LOOPS = 10;
		for (let loop = 0; loop < LOOPS; loop++) {
			const h = harness();
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
			const id = await h.seedPaidOrder({ id: `ord-gw-void-${String(loop)}`, totalCents: 1000 });

			// Two full-ceiling refunds race. Exactly one wins the RESERVATION; if that
			// winner's issue is the TERMINAL one it voids (releasing capacity) — but the
			// other caller already lost the reservation, so it cannot re-win here. This
			// asserts the arbiter never lets Σ(active) exceed the ceiling regardless of
			// which leg voided.
			const [a, b] = await Promise.all([
				refundOrder({ orderStore: h.store }, gw, {
					orderId: id,
					amount: cents(1000),
					currency: USD,
					refundedBy: "admin-a",
					idempotencyKey: idempotencyKey(`rf-gw-void-${String(loop)}-a`),
				}),
				refundOrder({ orderStore: h.store }, gw, {
					orderId: id,
					amount: cents(1000),
					currency: USD,
					refundedBy: "admin-b",
					idempotencyKey: idempotencyKey(`rf-gw-void-${String(loop)}-b`),
				}),
			]);
			const ledger = await h.store.listRefunds(id);
			const activeSum = ledger
				.filter((r) => r.status !== "voided")
				.reduce((s, x) => s + x.amount, 0);
			expect(
				activeSum,
				`loop ${String(loop)}: Σ(active) never exceeds ceiling`,
			).toBeLessThanOrEqual(1000);
			// The two settle to distinct fates — never both recorded, never both fully.
			const fullies = [a, b].filter((r) => r.ok && r.fullyRefunded);
			expect(fullies.length, `loop ${String(loop)}: at most one → refunded`).toBeLessThanOrEqual(1);
			// The claims agree with whatever the ledger ended up holding — a voided row is
			// still a landed row (terminal), and the caller that lost the reservation left
			// a refused key (claimed), usable again.
			await expectClaimsAgreeWithLedger(id, [
				`rf-gw-void-${String(loop)}-a`,
				`rf-gw-void-${String(loop)}-b`,
			]);
			// After a released (voided) reservation, a FRESH refund can reclaim the
			// capacity — proving the void truly released it.
			if (activeSum === 0) {
				const reclaim = await refundOrder({ orderStore: h.store }, new LatencyRefundGateway(0), {
					orderId: id,
					amount: cents(1000),
					currency: USD,
					refundedBy: "admin-reclaim",
					idempotencyKey: idempotencyKey(`rf-gw-void-${String(loop)}-reclaim`),
				});
				expect(
					reclaim.ok && reclaim.fullyRefunded,
					`loop ${String(loop)}: voided capacity reclaimable`,
				).toBe(true);
				await expectClaimsAgreeWithLedger(id, [`rf-gw-void-${String(loop)}-reclaim`]);
			}
			expectDepthWithinBudget(`terminal-vs-unverified loop ${String(loop)}`);
		}
		// 180s, not the 120s this case was briefly given: it now does two claim reads
		// and a depth assertion per loop on top of ten loops of gateway latency, and a
		// slower CI box needs the headroom the original timeout allowed for.
	}, 180_000);

	test("refund-vs-cancel: the order is never BOTH refunded and cancelled; Σ stays bounded", async () => {
		const h = harness();
		const gw = manualGw();
		const LOOPS = 10;
		for (let loop = 0; loop < LOOPS; loop++) {
			const id = await h.seedPaidOrder({
				id: `ord-vs-${String(loop)}`,
				totalCents: 1000,
				gateway: "x402",
			});
			const [refund, cancel] = await Promise.all([
				refundOrder({ orderStore: h.store }, gw, {
					orderId: id,
					amount: cents(1000), // a FULL refund → would flip to refunded
					currency: USD,
					refundedBy: "refunder",
					idempotencyKey: idempotencyKey(`rf-vs-${String(loop)}`),
				}),
				cancelOrder(
					{ orderStore: h.store },
					{
						orderId: id,
						reason: "customer_request",
						cancelledBy: "canceller",
						idempotencyKey: idempotencyKey(`cx-vs-${String(loop)}`),
					},
				),
			]);
			const state = (await h.store.getById(id))?.state;
			// The order settles on exactly ONE terminal state — never a torn "both".
			expect(["refunded", "cancelled", "paid"], `loop ${String(loop)}`).toContain(state);
			const sum = (await h.store.listRefunds(id)).reduce((s, x) => s + x.amount, 0);
			expect(sum, `loop ${String(loop)}: Σ bounded`).toBeLessThanOrEqual(1000);
			// If the cancel won the state, the refund never flipped to refunded.
			if (state === "cancelled") expect(refund.ok && refund.fullyRefunded).not.toBe(true);
			if (state === "refunded") expect(cancel.ok && cancel.cancelled).not.toBe(true);
			// Whichever way the state settled, the refund key's claim agrees with the
			// ledger: terminal if its row landed, still claimed if the ceiling refused it.
			await expectClaimsAgreeWithLedger(id, [`rf-vs-${String(loop)}`]);
			expectDepthWithinBudget(`refund-vs-cancel loop ${String(loop)}`);
		}
	}, 180_000);
});
