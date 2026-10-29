/**
 * The recount race (issue #619): a confirmed `recountUses` racing a crowd of real
 * redeems and releases must never LOSE a use the crowd took, nor COUNT one twice.
 *
 * **Postgres-required**, like every race in this package: better-sqlite3 serializes
 * writes in-process, so it can check the statements (the interleavings are pinned
 * deterministically in `coupon-recount.dialects.test.ts`) but cannot lose a race.
 *
 * THE SHAPE. A coupon holds `HELD` applied redemptions and its counter reads
 * `PHANTOM` more — the residue a release cut between its delete and its decrement
 * leaves. One look has already seen that drift, and its settle window has passed.
 * Then, all at once: a crowd of redeems against the cap, the releases of the held
 * redemptions, and a handful of recounts confirming that look.
 *
 * WHAT MUST HOLD, every loop:
 *  - no redemption is left mid-bump, and the cap is never passed;
 *  - the counter is EITHER exact (a recount's write won, before any counter write
 *    of the crowd) OR exactly `PHANTOM` high (the crowd moved the counter first, and
 *    every recount refused). Anything else — one low, one high of the phantom — is a
 *    use lost or counted twice;
 *  - at most one recount wrote;
 *  - and a later pair of looks makes it exact, after which a recount writes nothing.
 */
import {
	cents,
	COUPON_RECOUNT_SETTLE_MS,
	currency,
	idempotencyKey,
	orderId,
	type CouponRecountResult,
} from "@urumi.ai/otta-domain";
import { describe, expect, test } from "vitest";
import type { CouponDoc } from "../src/index.js";
import { COUPON_LAYOUT } from "./coupon-collections.js";
import { makeCouponHarness, type CouponHarness } from "./coupon-harness.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";

const AT = "2026-07-10T00:00:00.000Z";
const T0 = "2026-07-10T01:00:00.000Z";

function at(windows: number): string {
	return new Date(Date.parse(T0) + windows * COUPON_RECOUNT_SETTLE_MS).toISOString();
}

const MAX_USES = 20;
const HELD = 3;
const PHANTOM = 5;
const REDEEMERS = 30;
const RECOUNTERS = 8;
const LOOPS = 20;

function seed(usesCount: number): CouponDoc {
	return {
		couponId: "c1",
		code: "RECOUNT",
		codeKey: "recount",
		type: "fixed_amount",
		amountCents: cents(500),
		rateBps: null,
		capCents: null,
		currency: currency("USD"),
		minSubtotalCents: null,
		startsAt: null,
		expiresAt: null,
		maxUses: MAX_USES,
		maxUsesPerCustomer: null,
		usesCount,
		lastRedeemedKey: null,
		createdAt: AT,
	};
}

function redeemOf(h: CouponHarness, key: string) {
	return h.store.redeem({
		couponId: "c1",
		orderId: orderId(`o-${key}`),
		idempotencyKey: idempotencyKey(key),
		createdAt: AT,
	});
}

/** Look twice, a settle window apart, until the counter is exact. */
async function settle(h: CouponHarness, from: number): Promise<void> {
	const seen = await h.store.recountUses("c1", null, at(from));
	if (seen.outcome === "exact") return;
	if (seen.outcome !== "drift") throw new Error(`expected drift, got ${seen.outcome}`);
	expect(await h.store.recountUses("c1", seen.observation, at(from + 1))).toMatchObject({
		outcome: "corrected",
	});
}

describe.skipIf(!PG_ENABLED)("coupon recount race [postgres]", () => {
	for (const withReleases of [false, true]) {
		const label = withReleases ? "redeems and releases" : "redeems";
		test(`confirmed recounts racing ${label}: no use is lost or counted twice`, async () => {
			const db = await makePgStorage(COUPON_LAYOUT, REDEEMERS + RECOUNTERS + HELD + 4);
			try {
				let corrections = 0;
				for (let loop = 0; loop < LOOPS; loop++) {
					await db.reset();
					const h = makeCouponHarness(db.storage);
					await h.coupons.put("c1", seed(0));
					const held: string[] = [];
					for (let i = 0; i < HELD; i++) {
						const res = await redeemOf(h, `held-${String(loop)}-${String(i)}`);
						if (!res.ok) throw new Error("seed redeem refused");
						held.push(res.redemptionId);
					}
					// The phantom uses: a counter left high, with no redemption behind them.
					await h.coupons.put("c1", seed(HELD + PHANTOM));
					const first = await h.store.recountUses("c1", null, T0);
					if (first.outcome !== "drift") throw new Error(`expected drift, got ${first.outcome}`);

					const recounts: Promise<CouponRecountResult>[] = Array.from({ length: RECOUNTERS }, () =>
						h.store.recountUses("c1", first.observation, at(1)),
					);
					const redeems = Array.from({ length: REDEEMERS }, (_v, i) =>
						redeemOf(h, `k-${String(loop)}-${String(i)}`),
					);
					const releases = withReleases ? held.map((id) => h.store.release(id)) : [];
					const [answers, results] = await Promise.all([
						Promise.all(recounts),
						Promise.all(redeems),
						Promise.all(releases),
					]);

					const where = `loop ${String(loop)}`;
					expect(await h.redemptions.count({ couponId: "c1", state: "bumping" }), where).toBe(0);
					const applied = await h.redemptions.count({ couponId: "c1", state: "applied" });
					expect(applied, `${where}: the cap`).toBeLessThanOrEqual(MAX_USES);
					const admitted = results.filter((r) => r.ok).length;
					expect(applied, `${where}: every admitted redeem holds its use`).toBe(
						admitted + (withReleases ? 0 : HELD),
					);
					const wrote = answers.filter((a) => a.outcome === "corrected").length;
					expect(wrote, `${where}: recounts that wrote`).toBeLessThanOrEqual(1);
					corrections += wrote;
					const counted = (await h.usesOf("c1")) ?? -1;
					expect(
						counted - applied,
						`${where}: counter ${String(counted)} against ${String(applied)} held`,
					).toBe(wrote === 1 ? 0 : PHANTOM);

					await settle(h, 2);
					expect(await h.usesOf("c1"), where).toBe(applied);
					expect(await h.store.recountUses("c1", null, at(4)), where).toEqual({
						outcome: "exact",
						usesCount: applied,
					});
				}
				// Not a vacuous pass: some loops let a recount write while the crowd ran.
				// (Which ones depends on scheduling; that ANY did is what makes the
				// "never lost" half of the assertion bite.)
				expect(corrections).toBeGreaterThan(0);
			} finally {
				await db.close();
			}
		}, 180_000);
	}
});
