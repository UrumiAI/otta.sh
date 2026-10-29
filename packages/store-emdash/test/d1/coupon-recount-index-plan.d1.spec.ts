/**
 * The recount's two counts (issue #619) on **D1**, measured in rows read.
 *
 * The SQLite suite (`coupon-recount-index-plan.test.ts`) pins the plan. This one
 * measures what the plan costs on the dialect Otta ships on, and the cost is what
 * matters: a D1 Free database has a DAILY rows-read ceiling, and past it every
 * query fails, checkout included. With `state` indexed alone, a coupon's count read
 * every applied redemption in the store. With the `(couponId, state)` composite it
 * reads about that coupon's own rows.
 *
 * The physical indexes are built the way the host builds them (see
 * `coupon-index-plan.ts`); each count is replayed straight on the `DB` binding,
 * statement and parameters exactly as Kysely sent them, because D1 reports
 * `rows_read` per statement and the host's dialect does not hand it back.
 */
import { createDialect } from "@emdash-cms/cloudflare/db/d1";
import { idempotencyKey, orderId } from "@urumi.ai/otta-domain";
import { env } from "cloudflare:workers";
import { PluginStorageRepository } from "emdash";
import { runMigrations } from "emdash/db";
import { Kysely } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
	COUPON_COLLECTIONS,
	COUPON_REDEMPTIONS_COLLECTION,
	type CouponRedemptionDoc,
	type StorageAccess,
} from "../../src/index.js";
import { COUPON_LAYOUT } from "../coupon-collections.js";
import { makeCouponHarness, type CouponHarness } from "../coupon-harness.js";
import {
	createHostIndexes,
	PLAN_PLUGIN_ID,
	recountCounts,
	statementRecorder,
} from "../coupon-index-plan.js";

type HostDb = Parameters<typeof runMigrations>[0];

interface D1Binding {
	prepare(query: string): {
		bind(...values: unknown[]): {
			all(): Promise<{ meta: { rows_read?: number } }>;
		};
	};
}

const AT = "2026-07-10T00:00:00.000Z";
/** The coupon the recount counts, and how many applied uses it holds. */
const OWN_USES = 5;
/** Applied redemptions of OTHER coupons: what a bad plan reads through. */
const OTHER_APPLIED = 300;

const recorder = statementRecorder();
let db: HostDb;
let h: CouponHarness;

beforeAll(async () => {
	db = new Kysely({
		dialect: createDialect({ binding: "DB" }),
		log: (event) => recorder.log(event),
	}) as HostDb;
	await runMigrations(db);
	await createHostIndexes(
		db,
		COUPON_REDEMPTIONS_COLLECTION,
		COUPON_COLLECTIONS[COUPON_REDEMPTIONS_COLLECTION]?.indexes ?? [],
	);
	const storage: StorageAccess = {};
	for (const [name, config] of Object.entries(COUPON_LAYOUT)) {
		const indexes = [...(config.indexes ?? []), ...(config.uniqueIndexes ?? [])];
		storage[name] = new PluginStorageRepository(db, PLAN_PLUGIN_ID, name, indexes);
	}
	h = makeCouponHarness(storage);
	await h.seedCoupon({ id: "c1", code: "PLAN-C1", createdAt: AT });
	for (let i = 0; i < OWN_USES; i++) {
		const key = `own-${String(i)}`;
		const redeemed = await h.store.redeem({
			couponId: "c1",
			orderId: orderId(`o-${key}`),
			idempotencyKey: idempotencyKey(key),
			createdAt: AT,
		});
		expect(redeemed.ok).toBe(true);
	}
	// The rest of the store: applied redemptions of other coupons, written as the
	// documents a redeem leaves (only `couponId` and `state` reach the plan).
	const template = await h.redemptions.query({ where: { couponId: "c1" }, limit: 1 });
	const doc = template.items[0]?.data;
	if (doc === undefined) throw new Error("no redemption to copy");
	for (let i = 0; i < OTHER_APPLIED; i++) {
		const other: CouponRedemptionDoc = { ...doc, couponId: `other-${String(i % 30)}` };
		await h.redemptions.put(`other-${String(i)}`, other);
	}
}, 120_000);

afterAll(async () => {
	await db.destroy();
});

test("each recount count reads about the coupon's own rows, not every applied redemption", async () => {
	recorder.take();
	expect(await h.store.recountUses("c1", null, AT)).toEqual({
		outcome: "exact",
		usesCount: OWN_USES,
	});
	const counts = recountCounts(recorder.take());
	expect(counts).toHaveLength(2);
	const binding = env.DB as D1Binding;
	for (const count of counts) {
		const replay = await binding
			.prepare(count.sql)
			.bind(...count.parameters)
			.all();
		const read = replay.meta.rows_read ?? Number.POSITIVE_INFINITY;
		// A handful over the coupon's own uses at most; a `state`-only plan reads
		// all OTHER_APPLIED + OWN_USES applied rows.
		expect(read).toBeLessThanOrEqual(OWN_USES + 2);
	}
});
