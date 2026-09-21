/**
 * The no-over-redeem gate for `EmdashCouponStore` — Phase 6's analogue of the
 * inventory one, ported case for case from the SQL adapter's suite of the same name.
 *
 * It is **Postgres-required** and stays that way: better-sqlite3 serializes writes
 * in-process, so it can verify the statements but cannot lose a race. What is being
 * proven here is that the guarded `updateIf` refuses exactly the callers the SQL's
 * `WHERE uses_count < max_uses` refused, and that the inverted per-customer order —
 * slot first, counter second, with an idempotent compensation instead of a rollback —
 * admits exactly as many redemptions as the row lock did.
 *
 * The concurrency is the SQL suite's, unchanged (M=5, N=50, 20 loops), because that
 * is the shape that makes the guard actually fire: with a smaller crowd the refusals
 * can happen without any two bumps ever contending.
 */
import { cents, currency, customerId, idempotencyKey, orderId } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import type { CouponDoc, StorageCollection } from "../src/index.js";
import { COUPON_LAYOUT } from "./coupon-collections.js";
import { makeCouponHarness, type CouponHarness } from "./coupon-harness.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";

const AT = "2026-07-10T00:00:00.000Z";

/**
 * The hand-set attempt budget every shape here is held to — deliberately tighter
 * than `CAS_MAX_ATTEMPTS`, so raising the package ceiling can never turn a passing
 * shape green by accident. The bound is a property of the coupon: a retry happens
 * only when a DIFFERENT redemption committed, and for a capped coupon that is
 * bounded by the headroom left.
 */
const CAS_ATTEMPT_BUDGET = 8;

/**
 * The budget for the COUNTER step alone (`redeem`), as opposed to the bounded wait a
 * caller spends reading a peer's answer (`redeemAwait`).
 *
 * Two, and it is a hard bound rather than a measurement: the guarded `+1` can only be
 * refused because the coupon reached its cap, and the next read settles that. It does
 * NOT grow with the crowd — which is the whole reason once-only lives in the key
 * document instead of in the guard.
 */
const COUNTER_DEPTH_BUDGET = 2;

interface Fixture {
	harness: CouponHarness;
	coupons: StorageCollection<CouponDoc>;
	/** The deepest compare-and-set retry any step has spent so far. */
	maxAttempts(): number;
	/** The deepest retry spent by ONE named step — `redeem` is the counter itself. */
	maxAttemptsFor(operation: string): number;
	reset(): Promise<void>;
	close(): Promise<void>;
}

/** A coupon document seeded directly, so a loop can re-seed without a clock dance. */
function seed(maxUses: number | null, maxUsesPerCustomer: number | null): CouponDoc {
	return {
		couponId: "c1",
		code: "RACE",
		codeKey: "race",
		type: "fixed_amount",
		amountCents: cents(500),
		rateBps: null,
		capCents: null,
		currency: currency("USD"),
		minSubtotalCents: null,
		startsAt: null,
		expiresAt: null,
		maxUses,
		maxUsesPerCustomer,
		usesCount: 0,
		lastRedeemedKey: null,
		createdAt: AT,
	};
}

/** One isolated Postgres schema, its own pool, and a depth observer over it. */
async function fresh(poolMax: number): Promise<Fixture> {
	const db = await makePgStorage(COUPON_LAYOUT, poolMax);
	let deepest = 0;
	const perOperation = new Map<string, number>();
	const harness = makeCouponHarness(db.storage, {
		onCasAttempts: (operation, attempts) => {
			deepest = Math.max(deepest, attempts);
			perOperation.set(operation, Math.max(perOperation.get(operation) ?? 0, attempts));
		},
	});
	return {
		harness,
		coupons: harness.coupons,
		maxAttempts: () => deepest,
		maxAttemptsFor: (operation) => perOperation.get(operation) ?? 0,
		reset: () => db.reset(),
		close: () => db.close(),
	};
}

describe.skipIf(!PG_ENABLED)("coupon no-over-redeem [postgres]", () => {
	test("fires N concurrent redeem() at maxUses M (M<N); exactly M succeed and usesCount === M", async () => {
		const M = 5;
		const N = 50;
		const LOOPS = 20;
		const fx = await fresh(N + 4);
		try {
			for (let loop = 0; loop < LOOPS; loop++) {
				await fx.reset();
				await fx.coupons.put("c1", seed(M, null));

				const results = await Promise.all(
					Array.from({ length: N }, (_v, i) =>
						fx.harness.store.redeem({
							couponId: "c1",
							orderId: orderId(`o-${String(loop)}-${String(i)}`),
							idempotencyKey: idempotencyKey(`k-${String(loop)}-${String(i)}`),
							createdAt: AT,
						}),
					),
				);

				const ok = results.filter((r) => r.ok).length;
				expect(ok, `loop ${String(loop)}: ok count`).toBe(M);
				expect(results.length - ok, `loop ${String(loop)}: exhausted count`).toBe(N - M);
				expect((await fx.harness.store.findById("c1"))?.usesCount, `loop ${String(loop)}`).toBe(M);
				// Exactly M redemption records HOLD a use. The refused keys keep a record of
				// their refusal — that is what makes a replay answer the same way twice —
				// but a refusal holds nothing, exactly as the rolled-back row held nothing.
				const held = await fx.harness.redemptions.count({ couponId: "c1", holdsUse: "yes" });
				expect(held, `loop ${String(loop)}: records holding a use`).toBe(M);
				const refused = await fx.harness.redemptions.count({ couponId: "c1", holdsUse: "no" });
				expect(refused, `loop ${String(loop)}: refusals recorded`).toBe(N - M);
			}
			// Measured, not assumed: the counter step retries at most once, whatever the
			// crowd, because the only thing that can refuse it is the cap.
			expect(fx.maxAttemptsFor("redeem")).toBeLessThanOrEqual(COUNTER_DEPTH_BUDGET);
			expect(fx.maxAttempts()).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
		} finally {
			await fx.close();
		}
	}, 180_000);

	test("two same-customer concurrent redeems at maxUsesPerCustomer=1 (different keys) → exactly one succeeds", async () => {
		const LOOPS = 15;
		const fx = await fresh(8);
		const cust = customerId("cust-1");
		try {
			for (let loop = 0; loop < LOOPS; loop++) {
				await fx.reset();
				// Ample global headroom, per-customer cap of 1: the ONLY thing that may
				// refuse here is the per-customer counter's own revision race.
				await fx.coupons.put("c1", seed(100, 1));

				const results = await Promise.all([
					fx.harness.store.redeem({
						couponId: "c1",
						orderId: orderId(`o-${String(loop)}-a`),
						idempotencyKey: idempotencyKey(`k-${String(loop)}-a`),
						customerId: cust,
						createdAt: AT,
					}),
					fx.harness.store.redeem({
						couponId: "c1",
						orderId: orderId(`o-${String(loop)}-b`),
						idempotencyKey: idempotencyKey(`k-${String(loop)}-b`),
						customerId: cust,
						createdAt: AT,
					}),
				]);
				const ok = results.filter((r) => r.ok).length;
				expect(ok, `loop ${String(loop)}: exactly one succeeds`).toBe(1);
				expect((await fx.harness.store.findById("c1"))?.usesCount, `loop ${String(loop)}`).toBe(1);
				expect(
					await fx.harness.redemptions.count({ couponId: "c1", holdsUse: "yes" }),
					`loop ${String(loop)}: one record holds a use`,
				).toBe(1);
				// The refused caller consumed NO global headroom and holds NO slot: the
				// inverted order plus the compensation, under a real race.
				expect(
					await fx.harness.slotsOf("c1", "cust-1"),
					`loop ${String(loop)}: slots`,
				).toHaveLength(1);
			}
			// Two same-customer racers contend on the per-customer counter's revision,
			// not on the coupon's counter: the depth is the pair, not the crowd.
			expect(fx.maxAttempts()).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
		} finally {
			await fx.close();
		}
	}, 120_000);

	test("concurrent redeem() sharing the same idempotency key redeems exactly once", async () => {
		const N = 20;
		const fx = await fresh(N + 4);
		try {
			await fx.coupons.put("c1", seed(10, null));
			const key = idempotencyKey("same-key");
			const results = await Promise.all(
				Array.from({ length: N }, () =>
					fx.harness.store.redeem({
						couponId: "c1",
						orderId: orderId("o1"),
						idempotencyKey: key,
						createdAt: AT,
					}),
				),
			);

			// Every caller resolves to the SAME redemption, and the counter moves once —
			// the document id is the once-only guard the unique index used to be.
			const ok = results.filter((r) => r.ok);
			expect(ok).toHaveLength(N);
			expect(new Set(ok.map((r) => (r.ok ? r.redemptionId : ""))).size).toBe(1);
			expect((await fx.harness.store.findById("c1"))?.usesCount).toBe(1);
			expect(await fx.harness.redemptions.count({ couponId: "c1" })).toBe(1);
			// 20 callers completing ONE key: the key document's own state is what keeps the
			// count at one, so the COUNTER never contends. What the crowd costs is reads,
			// which is the bounded wait and not a write.
			expect(fx.maxAttemptsFor("redeem")).toBeLessThanOrEqual(COUNTER_DEPTH_BUDGET);
			expect(fx.maxAttempts()).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
		} finally {
			await fx.close();
		}
	}, 120_000);

	test("a crowd redeeming an UNCAPPED coupon counts every one of them", async () => {
		// The other branch of the split `OR`: with no cap there is no guard, so the
		// unguarded delta must still be exact under contention — N bumps, N uses.
		const N = 40;
		const fx = await fresh(N + 4);
		try {
			await fx.coupons.put("c1", seed(null, null));
			const results = await Promise.all(
				Array.from({ length: N }, (_v, i) =>
					fx.harness.store.redeem({
						couponId: "c1",
						orderId: orderId(`o-u-${String(i)}`),
						idempotencyKey: idempotencyKey(`k-u-${String(i)}`),
						createdAt: AT,
					}),
				),
			);
			expect(results.filter((r) => r.ok)).toHaveLength(N);
			expect((await fx.harness.store.findById("c1"))?.usesCount).toBe(N);
			// The unguarded branch never contends: nothing pins a witness, so no caller
			// is ever asked to re-read.
			expect(fx.maxAttempts()).toBe(1);
		} finally {
			await fx.close();
		}
	}, 120_000);

	test("20 completers of ONE key WHILE peer keys commit: exactly one use for that key, capped and uncapped", async () => {
		// The case the witness-pinned design could not pass. A crowd completing one
		// idempotency key must add exactly ONE use — and the peers are the point: they
		// commit inside the window, so any design that decides "did my key already bump?"
		// by reading a single shared witness field sees it overwritten and bumps again.
		const SHARED = 20;
		const PEERS = 20;
		const LOOPS = 3;
		const fx = await fresh(SHARED + PEERS + 4);
		try {
			for (const [loop, maxUses] of [100, null, 100, null, 100, null]
				.slice(0, 2 * LOOPS)
				.entries()) {
				await fx.reset();
				await fx.coupons.put("c1", seed(maxUses, null));
				const shared = idempotencyKey("k-shared");

				const results = await Promise.all([
					...Array.from({ length: SHARED }, () =>
						fx.harness.store.redeem({
							couponId: "c1",
							orderId: orderId("o-shared"),
							idempotencyKey: shared,
							createdAt: AT,
						}),
					),
					...Array.from({ length: PEERS }, (_v, i) =>
						fx.harness.store.redeem({
							couponId: "c1",
							orderId: orderId(`o-peer-${String(i)}`),
							idempotencyKey: idempotencyKey(`k-peer-${String(i)}`),
							createdAt: AT,
						}),
					),
				]);

				const label = `${maxUses === null ? "uncapped" : "capped"} loop ${String(loop)}`;
				expect(
					results.filter((r) => r.ok),
					label,
				).toHaveLength(SHARED + PEERS);
				// One use for the shared key, one per peer — nothing over-counted.
				expect((await fx.harness.store.findById("c1"))?.usesCount, label).toBe(1 + PEERS);
				// Every completer of the shared key answers with the same redemption id, and
				// the key holds exactly ONE record, in exactly one terminal state.
				const ids = new Set(
					results.slice(0, SHARED).map((r) => (r.ok ? r.redemptionId : "not-ok")),
				);
				expect(ids.size, label).toBe(1);
				const record = await fx.harness.redemptions.get(`c1:${shared}`);
				expect(record?.state, label).toBe("applied");
				expect(fx.maxAttemptsFor("redeem"), label).toBeLessThanOrEqual(COUNTER_DEPTH_BUDGET);
				expect(await fx.harness.redemptions.count({ couponId: "c1", holdsUse: "yes" }), label).toBe(
					1 + PEERS,
				);
			}
		} finally {
			await fx.close();
		}
	}, 180_000);

	test("a crowd LARGER than the attempt ceiling all succeed: the counter's depth follows the headroom, not the crowd", async () => {
		// 50 racers against a 24-attempt ceiling on a coupon with 95 uses left. A guard
		// that pinned a per-key witness would make every racer contend with every other
		// racer and exhaust the budget; guarding on the cap alone means a racer can only
		// be asked to re-read when the coupon actually reached its cap, which never
		// happens here.
		const N = 50;
		const fx = await fresh(N + 4);
		try {
			await fx.coupons.put("c1", seed(95, null));
			const results = await Promise.all(
				Array.from({ length: N }, (_v, i) =>
					fx.harness.store.redeem({
						couponId: "c1",
						orderId: orderId(`o-wide-${String(i)}`),
						idempotencyKey: idempotencyKey(`k-wide-${String(i)}`),
						createdAt: AT,
					}),
				),
			);
			expect(results.filter((r) => r.ok)).toHaveLength(N);
			expect((await fx.harness.store.findById("c1"))?.usesCount).toBe(N);
			// The counter step itself never retried: no racer was ever asked to re-read,
			// because no racer's guard could fail with 45 uses still spare.
			expect(fx.maxAttemptsFor("redeem")).toBe(1);
		} finally {
			await fx.close();
		}
	}, 180_000);
});
