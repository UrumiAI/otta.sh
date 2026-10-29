/**
 * The query plan behind `recountUses`' two counts (issue #619), on SQLite.
 *
 * `recountUses` counts a coupon's `bumping` and `applied` redemptions with
 * `count({ couponId, state })`. The host never runs `ANALYZE`, so SQLite (and D1,
 * which is SQLite) plans that without statistics. Given single-field indexes on
 * `couponId` and on `state`, it took the one created last — `state` — and counted a
 * coupon's applied uses by reading every applied redemption in the store. The
 * declaration is therefore the composite `["couponId", "state"]`, and this suite
 * pins the plan it buys: both counts SEARCH that index on both equality terms.
 *
 * The second case is the control: the earlier declaration (`state` alone, created
 * last) must plan the bad way here, or this suite could not tell the two apart.
 * The D1 tier measures the same thing in rows read
 * (`d1/coupon-recount-index-plan.d1.spec.ts`).
 */
import { idempotencyKey, orderId } from "@urumi.ai/otta-domain";
import Database from "better-sqlite3";
import { PluginStorageRepository } from "emdash";
import { runMigrations } from "emdash/db";
import { Kysely, SqliteDialect } from "kysely";
import { expect, test } from "vitest";
import {
	COUPON_COLLECTIONS,
	COUPON_REDEMPTIONS_COLLECTION,
	type StorageAccess,
} from "../src/index.js";
import { COUPON_LAYOUT } from "./coupon-collections.js";
import { makeCouponHarness } from "./coupon-harness.js";
import {
	createHostIndexes,
	hostIndexName,
	PLAN_PLUGIN_ID,
	recountCounts,
	statementRecorder,
} from "./coupon-index-plan.js";

type HostDb = Parameters<typeof runMigrations>[0];

const AT = "2026-07-10T00:00:00.000Z";
const COMPOSITE = hostIndexName(COUPON_REDEMPTIONS_COLLECTION, ["couponId", "state"]);

/** The plan SQLite chooses for each of the recount's counts, given these indexes. */
async function recountPlans(
	redemptionIndexes: readonly (string | readonly string[])[],
): Promise<string[]> {
	const raw = new Database(":memory:");
	const recorder = statementRecorder();
	const db = new Kysely({
		dialect: new SqliteDialect({ database: raw }),
		log: (event) => recorder.log(event),
	}) as HostDb;
	try {
		await runMigrations(db);
		await createHostIndexes(db, COUPON_REDEMPTIONS_COLLECTION, redemptionIndexes);
		const storage: StorageAccess = {};
		for (const [name, config] of Object.entries(COUPON_LAYOUT)) {
			const indexes = [...(config.indexes ?? []), ...(config.uniqueIndexes ?? [])];
			storage[name] = new PluginStorageRepository(db, PLAN_PLUGIN_ID, name, indexes);
		}
		const h = makeCouponHarness(storage);
		for (const id of ["c1", "c2"]) {
			await h.seedCoupon({ id, code: `PLAN-${id}`, createdAt: AT });
			for (let i = 0; i < 3; i++) {
				const key = `${id}-${String(i)}`;
				const redeemed = await h.store.redeem({
					couponId: id,
					orderId: orderId(`o-${key}`),
					idempotencyKey: idempotencyKey(key),
					createdAt: AT,
				});
				expect(redeemed.ok).toBe(true);
			}
		}
		recorder.take();
		expect(await h.store.recountUses("c1", null, AT)).toEqual({ outcome: "exact", usesCount: 3 });
		const counts = recountCounts(recorder.take());
		// Bumping, then applied.
		expect(counts).toHaveLength(2);
		return counts.map((count) =>
			raw
				.prepare(`EXPLAIN QUERY PLAN ${count.sql}`)
				.all(...(count.parameters as unknown[]))
				.map((row) => (row as { detail: string }).detail)
				.join(" | "),
		);
	} finally {
		await db.destroy();
	}
}

test("both recount counts search the (couponId, state) composite on both terms", async () => {
	const declared = COUPON_COLLECTIONS[COUPON_REDEMPTIONS_COLLECTION]?.indexes ?? [];
	const plans = await recountPlans(declared);
	for (const plan of plans) {
		// `COVERING` on SQLite: the count never touches the table rows at all.
		expect(plan).toMatch(new RegExp(`USING (COVERING )?INDEX ${COMPOSITE} \\(`));
		// Both JSON terms bound by the index: no residual scan of a coupon's rows.
		expect(plan).toMatch(/<expr>=\? AND <expr>=\?\)/);
	}
});

test("control: a lone state index, created last, is the one SQLite takes", async () => {
	const legacy = [
		"couponId",
		"orderId",
		"idempotencyKey",
		"createdAt",
		"redemptionId",
		"holdsUse",
		"state",
	];
	const plans = await recountPlans(legacy);
	for (const plan of plans) {
		expect(plan).toMatch(
			new RegExp(
				`USING (COVERING )?INDEX ${hostIndexName(COUPON_REDEMPTIONS_COLLECTION, ["state"])} \\(`,
			),
		);
	}
});
