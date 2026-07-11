import { idempotencyKey, orderId, reconcileCouponRedemptions } from "@urumi/domain";
import { CountingIdGen, FixedClock } from "@urumi/domain/testing";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import {
	KyselyCouponStore,
	KyselyOrderStore,
	makeSqliteDb,
	migrateToLatest,
	uuidIdGen,
} from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

const PG = process.env.PG_CONNECTION_STRING;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

interface Fixture {
	couponStore: KyselyCouponStore;
	orderStore: KyselyOrderStore;
	db: Kysely<Database>;
	clock: FixedClock;
}

function build(db: Kysely<Database>): Fixture {
	const clock = new FixedClock(new Date("2026-07-10T01:00:00.000Z"));
	return {
		db,
		clock,
		couponStore: new KyselyCouponStore({ db, idGen: uuidIdGen }),
		orderStore: new KyselyOrderStore({ db, idGen: new CountingIdGen("oi"), clock }),
	};
}

async function makeSqliteFixture(): Promise<Fixture> {
	const db = makeSqliteDb(":memory:");
	await migrateToLatest(db);
	cleanups.push(async () => {
		await db.destroy();
	});
	return build(db);
}

async function makePgFixture(): Promise<Fixture> {
	if (PG === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(PG, { poolMax: 4 });
	cleanups.push(() => iso.teardown());
	return build(iso.db);
}

async function seedCoupon(db: Kysely<Database>): Promise<void> {
	await db
		.insertInto("coupons")
		.values({
			id: "c1",
			code: "SWEEP",
			type: "fixed_amount",
			amount_cents: 500,
			rate_bps: null,
			cap_cents: null,
			currency: "USD",
			min_subtotal_cents: null,
			starts_at: null,
			expires_at: null,
			max_uses: 10,
			max_uses_per_customer: null,
			uses_count: 0,
		})
		.execute();
}

/** Insert a minimal durable order + order_totals row (so getById returns it). */
async function seedDurableOrder(db: Kysely<Database>, id: string): Promise<void> {
	await db
		.insertInto("orders")
		.values({
			id,
			cart_id: null,
			currency: "USD",
			state: "pending",
			idempotency_key: `order-key-${id}`,
			hold_expires_at: "2026-07-10T02:00:00.000Z",
			payment_method: null,
			buyer_ref: "b@example.com",
			created_at: "2026-07-10T00:00:00.000Z",
			updated_at: "2026-07-10T00:00:00.000Z",
		})
		.execute();
	await db
		.insertInto("order_totals")
		.values({
			order_id: id,
			currency: "USD",
			subtotal_cents: 500,
			discount_cents: 0,
			shipping_cents: 0,
			tax_cents: 0,
			total_cents: 500,
			applied_coupon_code: null,
			shipping_method_snapshot: null,
			tax_breakdown: null,
		})
		.execute();
}

const GRACE = { graceMs: 15 * 60 * 1000 };

function suite(makeFixture: () => Promise<Fixture>, dialect: string): void {
	describe(`coupon reconciliation sweep [${dialect}]`, () => {
		test("releases a redemption whose order never became durable within the grace window, and leaves alone one whose order exists", async () => {
			const fx = await makeFixture();
			await seedCoupon(fx.db);

			// Redemption A: order NEVER became durable (crash mid-request), created
			// before the grace cutoff (now 01:00, grace 15m ⇒ cutoff 00:45).
			const a = await fx.couponStore.redeem({
				couponId: "c1",
				orderId: orderId("o-stranded"),
				idempotencyKey: idempotencyKey("k-a"),
				createdAt: "2026-07-10T00:00:00.000Z",
			});
			// Redemption B: its order IS durable — must be left alone.
			await seedDurableOrder(fx.db, "o-durable");
			const b = await fx.couponStore.redeem({
				couponId: "c1",
				orderId: orderId("o-durable"),
				idempotencyKey: idempotencyKey("k-b"),
				createdAt: "2026-07-10T00:00:00.000Z",
			});
			expect(a.ok && b.ok).toBe(true);
			if (!a.ok || !b.ok) return;
			expect((await fx.couponStore.findById("c1"))?.usesCount).toBe(2);

			const released = await reconcileCouponRedemptions(
				{ couponStore: fx.couponStore, orderStore: fx.orderStore, clock: fx.clock },
				GRACE,
			);
			expect(released).toBe(1);

			// A was released (row gone, uses decremented); B untouched.
			const remaining = await fx.couponStore.listRedemptionsCreatedBefore(
				"9999-12-31T00:00:00.000Z",
			);
			expect(remaining.map((r) => r.id)).toEqual([b.redemptionId]);
			expect((await fx.couponStore.findById("c1"))?.usesCount).toBe(1);
		});

		test("does not release a stranded redemption still inside the grace window", async () => {
			const fx = await makeFixture();
			await seedCoupon(fx.db);
			// Created at 00:50, cutoff is 00:45 ⇒ not yet eligible.
			await fx.couponStore.redeem({
				couponId: "c1",
				orderId: orderId("o-recent"),
				idempotencyKey: idempotencyKey("k-recent"),
				createdAt: "2026-07-10T00:50:00.000Z",
			});
			const released = await reconcileCouponRedemptions(
				{ couponStore: fx.couponStore, orderStore: fx.orderStore, clock: fx.clock },
				GRACE,
			);
			expect(released).toBe(0);
			expect((await fx.couponStore.findById("c1"))?.usesCount).toBe(1);
		});
	});
}

suite(makeSqliteFixture, "sqlite");
if (PG !== undefined) suite(makePgFixture, "postgres");
