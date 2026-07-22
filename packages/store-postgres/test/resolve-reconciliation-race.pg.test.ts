import { orderId as toOrderId, idempotencyKey } from "@urumi/domain";
import { CountingIdGen, FixedClock } from "@urumi/domain/testing";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { KyselyOrderStore } from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

const PG = process.env.PG_CONNECTION_STRING;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

interface Fixture {
	store: KyselyOrderStore;
	db: Kysely<Database>;
	seedFlagged(id: string): Promise<void>;
}

/** A schema-isolated pg order store whose pool holds `poolMax` connections, so N
 *  concurrent resolves each take an INDEPENDENT connection (a real row race). */
async function freshStore(poolMax: number): Promise<Fixture> {
	if (PG === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(PG, { poolMax });
	cleanups.push(() => iso.teardown());
	const db = iso.db;
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const store = new KyselyOrderStore({ db, idGen: new CountingIdGen("oi"), clock });
	return {
		store,
		db,
		async seedFlagged(id) {
			await db
				.insertInto("orders")
				.values({
					id,
					cart_id: null,
					currency: "USD",
					state: "paid",
					idempotency_key: `seed-${id}`,
					hold_expires_at: "2026-07-10T00:00:00.000Z",
					payment_method: "stripe",
					buyer_ref: "buyer@example.com",
					customer_id: null,
					reconciliation_flag: "commit lost for reservation res-1",
					created_at: "2026-07-10T00:00:00.000Z",
					updated_at: "2026-07-10T00:00:00.000Z",
				})
				.execute();
			await db
				.insertInto("order_totals")
				.values({
					order_id: id,
					currency: "USD",
					subtotal_cents: 1000,
					discount_cents: 0,
					shipping_cents: 0,
					tax_cents: 0,
					total_cents: 1000,
					applied_coupon_code: null,
					shipping_method_snapshot: null,
					tax_breakdown: null,
				})
				.execute();
		},
	};
}

describe.skipIf(PG === undefined)("resolveReconciliation race [postgres]", () => {
	test("N concurrent resolves on one flagged order yield exactly ONE winner; the disposition is written once — Postgres", async () => {
		const N = 30;
		const LOOPS = 15;
		const h = await freshStore(N + 4);

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `ord-race-${loop}`;
			await h.seedFlagged(id);

			// Each caller carries a distinct outcome/reason so we can prove WHICH one
			// the single winner persisted (only the guarded-flip winner may write).
			const results = await Promise.all(
				Array.from({ length: N }, (_unused, i) =>
					h.store.resolveReconciliation({
						orderId: toOrderId(id),
						// Every caller reviewed the SAME live flag — the race is on the clear.
						expectedFlag: "commit lost for reservation res-1",
						outcome: i % 2 === 0 ? "fulfilled" : "refunded",
						reason: `caller ${i}`,
						resolvedBy: `admin-${i}`,
						idempotencyKey: idempotencyKey(`res-${loop}-${i}`),
					}),
				),
			);

			const winners = results.filter((r) => r.resolved);
			expect(winners, `loop ${loop}: exactly one winner`).toHaveLength(1);
			expect(
				results.filter((r) => !r.resolved),
				`loop ${loop}: losers`,
			).toHaveLength(N - 1);

			// The persisted disposition matches the winner's exactly, and the flag is
			// cleared — no torn write, no double-resolve.
			const after = await h.store.getById(toOrderId(id));
			expect(after?.reconciliationFlag, `loop ${loop}: flag cleared`).toBeNull();
			const wonReason = winners[0]?.order?.reconciliationResolution?.reason;
			expect(after?.reconciliationResolution?.reason, `loop ${loop}: winner's reason`).toBe(
				wonReason,
			);
			expect(after?.reconciliationResolution?.resolvedBy).toBe(
				winners[0]?.order?.reconciliationResolution?.resolvedBy,
			);
			expect(after?.state, `loop ${loop}: state untouched`).toBe("paid");
		}
	}, 120_000);
});
