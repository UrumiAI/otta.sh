import { idempotencyKey, orderId } from "@urumi/domain";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { KyselyCouponStore, uuidIdGen } from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

const PG = process.env.PG_CONNECTION_STRING;

interface Fixture {
	store: KyselyCouponStore;
	db: Kysely<Database>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

async function freshStore(poolMax: number): Promise<Fixture> {
	if (PG === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(PG, { poolMax });
	cleanups.push(() => iso.teardown());
	return { store: new KyselyCouponStore({ db: iso.db, idGen: uuidIdGen }), db: iso.db };
}

async function seedCoupon(db: Kysely<Database>, maxUses: number): Promise<void> {
	await db
		.insertInto("coupons")
		.values({
			id: "c1",
			code: "RACE",
			type: "fixed_amount",
			amount_cents: 500,
			rate_bps: null,
			cap_cents: null,
			currency: "USD",
			min_subtotal_cents: null,
			starts_at: null,
			expires_at: null,
			max_uses: maxUses,
			max_uses_per_customer: null,
			uses_count: 0,
		})
		.execute();
}

// This is Phase 6's analogue of the Phase-0.5 no-oversell gate. better-sqlite3
// serializes writes in-process and cannot exercise the race, so it is
// Postgres-required (DEVELOPMENT.md §2).
describe.skipIf(PG === undefined)("coupon no-over-redeem [postgres]", () => {
	test("fires N concurrent redeem() at maxUses M (M<N); exactly M succeed and uses_count === M — Postgres", async () => {
		const M = 5;
		const N = 50;
		const LOOPS = 20;
		const h = await freshStore(N + 4);

		for (let loop = 0; loop < LOOPS; loop++) {
			await h.db.deleteFrom("coupon_redemptions").execute();
			await h.db.deleteFrom("coupons").execute();
			await seedCoupon(h.db, M);

			const results = await Promise.all(
				Array.from({ length: N }, (_v, i) =>
					h.store.redeem({
						couponId: "c1",
						orderId: orderId(`o-${loop}-${i}`),
						idempotencyKey: idempotencyKey(`k-${loop}-${i}`),
						createdAt: "2026-07-10T00:00:00.000Z",
					}),
				),
			);

			const ok = results.filter((r) => r.ok).length;
			const exhausted = results.filter((r) => !r.ok).length;
			expect(ok, `loop ${loop}: ok count`).toBe(M);
			expect(exhausted, `loop ${loop}: exhausted count`).toBe(N - M);

			const coupon = await h.store.findById("c1");
			expect(coupon?.usesCount, `loop ${loop}: uses_count`).toBe(M);
			// Exactly M durable redemption rows — the exhausted attempts rolled back.
			const rows = await h.db.selectFrom("coupon_redemptions").selectAll().execute();
			expect(rows, `loop ${loop}: redemption rows`).toHaveLength(M);
		}
	}, 120_000);

	test("concurrent redeem() sharing the same idempotency key redeems exactly once — Postgres", async () => {
		const N = 20;
		const h = await freshStore(N + 4);
		await seedCoupon(h.db, 10);
		const key = idempotencyKey("same-key");

		const results = await Promise.all(
			Array.from({ length: N }, () =>
				h.store.redeem({
					couponId: "c1",
					orderId: orderId("o1"),
					idempotencyKey: key,
					createdAt: "2026-07-10T00:00:00.000Z",
				}),
			),
		);

		// Every caller resolves to the same single redemption; uses_count moves once.
		const ok = results.filter((r) => r.ok);
		expect(ok).toHaveLength(N);
		const ids = new Set(ok.map((r) => (r.ok ? r.redemptionId : "")));
		expect(ids.size).toBe(1);
		expect((await h.store.findById("c1"))?.usesCount).toBe(1);
		const rows = await h.db.selectFrom("coupon_redemptions").selectAll().execute();
		expect(rows).toHaveLength(1);
	}, 60_000);
});
