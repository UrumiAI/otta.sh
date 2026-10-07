/**
 * The day document's two stored shapes: the flat, guarded one every write now produces,
 * and the LEGACY nested one the first rollup wrote, which existing stores still hold.
 *
 * A live event is one guarded numeric delta, and the host's delta addresses a top-level
 * field only, so the counters are stored flat (`state_<state>`, beside `revenueCents` and
 * the rest) with two guards, `epoch` (moved by a recompute's commit) and `seq` (moved by
 * every delta). A document written before that has none of it: a nested `stateCounts`
 * map and no guards. Migrations are forward-only, so such a document is never rewritten
 * just for being old. It is READ as it stands, and moved to the current shape the first
 * time something has a reason to write it. These cases pin both halves.
 *
 * Shared by the Node dialects (`reporting-stored-shape.dialects.test.ts`) and D1
 * (`d1/reporting-stored-shape.d1.spec.ts`): the migration path rides the host's
 * SQLite JSON functions on D1, and D1 is the dialect Otta ships on. It names no Node
 * driver, so it loads inside `workerd`.
 */
import type { DateRange } from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	collectionOf,
	ORDERS_COLLECTION,
	REPORTING_APPLIED_COLLECTION,
	reportingTransitionClaimId,
	type ReportingAnomaly,
	type ReportingDailyStoredDoc,
	type StorageAccess,
	type StorageCollection,
} from "../src/index.js";
import { delegatingCollection, withCollection } from "./helpers/fault-injection.js";
import { makeReportingHarness, type ReportingHarness } from "./reporting-harness.js";

const RANGE: DateRange = { from: "2026-07-01T00:00:00.000Z", to: "2026-07-31T23:59:59.999Z" };
const DAY = "2026-07-04T09:00:00.000Z";
const BUCKET = "USD:2026-07-04";

/**
 * Two orders on one day, one paid, one pending, with their claims absorbed, and then the
 * day document REPLACED by the legacy nested shape holding the same counters: exactly what
 * a store that ran the old rollup is sitting on.
 */
async function legacyDay(h: ReportingHarness): Promise<void> {
	await h.seedOrder({
		id: "l1",
		state: "pending",
		currency: "USD",
		createdAt: DAY,
		totalCents: 4000,
	});
	await h.transitionOrder("l1", "paid");
	await h.seedOrder({
		id: "l2",
		state: "pending",
		currency: "USD",
		createdAt: DAY,
		totalCents: 1500,
	});
	await h.store.reconcile(RANGE);
	const legacy: ReportingDailyStoredDoc = {
		currency: "USD",
		date: "2026-07-04",
		stateCounts: { paid: 1, pending: 1 },
		revenueOrders: 1,
		revenueCents: 4000,
		refundEntries: 0,
		refundedCents: 0,
		updatedAt: "2026-07-04T10:00:00.000Z",
	};
	await h.dailyRaw.put(BUCKET, legacy);
}

/**
 * A day document an OLDER version of this adapter has rewritten over the current shape:
 * what a mixed-version deploy or a rollback leaves. Two orders are rolled up and
 * reconciled by the current code (so the document is flat, guarded, and at `epoch` 1),
 * then an old worker moves `h2` from pending to paid. Its order write is durable and it
 * claims the event, but its rollup is a compare-and-set of the document it read, spread,
 * with its revenue added to the top-level fields and a nested `stateCounts` map built from
 * nothing holding only its own increment. The flat state fields never see that move.
 */
async function hybridDay(h: ReportingHarness): Promise<void> {
	await h.seedOrder({
		id: "h1",
		state: "pending",
		currency: "USD",
		createdAt: DAY,
		totalCents: 4000,
	});
	await h.transitionOrder("h1", "paid");
	await h.seedOrder({
		id: "h2",
		state: "pending",
		currency: "USD",
		createdAt: DAY,
		totalCents: 1500,
	});
	await h.store.reconcile(RANGE);
	const current = await h.dailyRaw.get(BUCKET);
	expect(current).toMatchObject({ epoch: 1, seq: 3, state_paid: 1, state_pending: 1 });

	// The old worker's transition.
	await h.moveOrderDocument("h2", "paid");
	const at = h.now();
	await h.applied.put(reportingTransitionClaimId("h2", "pending", "paid"), {
		orderId: "h2",
		kind: "transition",
		date: "2026-07-04",
		currency: "USD",
		fromState: "pending",
		toState: "paid",
		refundId: null,
		amountCents: null,
		claimedAt: at,
		appliedAt: at,
		absorbedAt: null,
	});
	await h.dailyRaw.put(BUCKET, {
		...current,
		currency: "USD",
		date: "2026-07-04",
		revenueOrders: 2,
		revenueCents: 5500,
		stateCounts: { paid: 1 },
		updatedAt: at,
	});
}

/**
 * The store's storage with every `query` on the orders and claims collections counted:
 * a day recompute pages both, and a live event pages neither.
 */
function countingScans(storage: StorageAccess): { storage: StorageAccess; scans: () => number } {
	let scans = 0;
	const counted = (name: string): StorageCollection => {
		const raw = collectionOf(storage, name);
		return delegatingCollection(raw, {
			query: (options) => {
				scans++;
				return raw.query(options);
			},
		});
	};
	let wrapped = withCollection(storage, ORDERS_COLLECTION, counted(ORDERS_COLLECTION));
	wrapped = withCollection(
		wrapped,
		REPORTING_APPLIED_COLLECTION,
		counted(REPORTING_APPLIED_COLLECTION),
	);
	return { storage: wrapped, scans: () => scans };
}

/** Register the stored-shape cases against `bound`'s storage. */
export function reportingStoredShapeCases(bound: { readonly storage: StorageAccess }): void {
	test("a live event stores the counters flat, with the guards, and bumps seq once per delta", async () => {
		const h = makeReportingHarness(bound.storage);
		await h.seedOrder({
			id: "f1",
			state: "pending",
			currency: "USD",
			createdAt: DAY,
			totalCents: 900,
		});
		await h.transitionOrder("f1", "paid");
		const raw = await h.dailyRaw.get(BUCKET);
		expect(raw).toMatchObject({
			currency: "USD",
			date: "2026-07-04",
			epoch: 0,
			seq: 2,
			state_paid: 1,
			state_pending: 0,
			revenueOrders: 1,
			revenueCents: 900,
		});
		expect(raw?.stateCounts).toBeUndefined();
		// The zeroed state is storage, not value: it does not read as a bucket.
		expect(await h.store.ordersByStatus(RANGE)).toEqual([{ status: "paid", orderCount: 1 }]);
	});

	test("a recompute's commit bumps the epoch and leaves seq alone", async () => {
		const h = makeReportingHarness(bound.storage);
		await h.seedOrder({
			id: "e1",
			state: "pending",
			currency: "USD",
			createdAt: DAY,
			totalCents: 300,
		});
		// A lost rollup, so the recompute has a correction to commit.
		await h.moveOrderDocument("e1", "paid");
		const done = await h.store.reconcile(RANGE);
		expect(done.documentsWritten).toBe(1);
		expect(await h.dailyRaw.get(BUCKET)).toMatchObject({
			epoch: 1,
			seq: 1,
			state_paid: 1,
			state_pending: 0,
			revenueCents: 300,
		});
	});

	test("a LEGACY nested document is read exactly as it stands", async () => {
		const h = makeReportingHarness(bound.storage);
		await legacyDay(h);
		expect((await h.dailyRaw.get(BUCKET))?.stateCounts).toEqual({ paid: 1, pending: 1 });
		expect(await h.store.revenueByPeriod(RANGE, "day")).toEqual([
			{
				bucketStart: "2026-07-04T00:00:00.000Z",
				currency: "USD",
				revenueCents: 4000,
				refundedCents: 0,
			},
		]);
		expect(await h.store.ordersByStatus(RANGE)).toEqual([
			{ status: "paid", orderCount: 1 },
			{ status: "pending", orderCount: 1 },
		]);
	});

	test("the first live event on a LEGACY document migrates it forward and counts exactly", async () => {
		const h = makeReportingHarness(bound.storage);
		await legacyDay(h);
		await h.transitionOrder("l2", "paid");
		await h.refundOrder("l1", 250);

		const raw = await h.dailyRaw.get(BUCKET);
		expect(raw?.stateCounts).toBeUndefined();
		expect(raw).toMatchObject({ epoch: 0, state_paid: 2, state_pending: 0 });
		expect(await h.daily.get(BUCKET)).toMatchObject({
			stateCounts: { paid: 2 },
			revenueOrders: 2,
			revenueCents: 5500,
			refundEntries: 1,
			refundedCents: 250,
		});
		// And the delta stream still agrees with the definition.
		const done = await h.store.reconcile(RANGE);
		expect(done.documentsWritten).toBe(0);
	});

	test("a recompute leaves an exact LEGACY document alone, and migrates it when it has a correction", async () => {
		const h = makeReportingHarness(bound.storage);
		await legacyDay(h);
		// Exact, and every claim already absorbed: forward-only means no rewrite for age alone.
		const idle = await h.store.reconcile(RANGE);
		expect(idle.documentsWritten).toBe(0);
		expect((await h.dailyRaw.get(BUCKET))?.stateCounts).toEqual({ paid: 1, pending: 1 });

		// A lost rollup gives it something to commit, and the commit writes the current shape.
		await h.moveOrderDocument("l2", "paid");
		const healed = await h.store.reconcile(RANGE);
		expect(healed.documentsWritten).toBe(1);
		const raw = await h.dailyRaw.get(BUCKET);
		expect(raw?.stateCounts).toBeUndefined();
		expect(raw).toMatchObject({ epoch: 1, seq: 0, state_paid: 2, revenueCents: 5500 });

		// A delta after the migration lands on top of it.
		await h.refundOrder("l2", 100);
		expect(await h.daily.get(BUCKET)).toMatchObject({
			stateCounts: { paid: 2 },
			revenueCents: 5500,
			refundedCents: 100,
		});
	});

	test("the next event UN-TAINTS a hybrid document in one guarded write, counts, and does not recompute the day", async () => {
		const seeded = makeReportingHarness(bound.storage);
		await hybridDay(seeded);

		const anomalies: ReportingAnomaly[] = [];
		const counting = countingScans(bound.storage);
		const h = makeReportingHarness(bound.storage, {
			clock: seeded.clock,
			storageForStore: counting.storage,
			onAnomaly: (anomaly) => anomalies.push(anomaly),
		});
		await h.refundOrder("h1", 250);

		// No recompute ran inline: neither the orders nor the day's claims were paged.
		expect(counting.scans()).toBe(0);
		expect(anomalies).toEqual([
			{ kind: "tainted", docId: BUCKET, orderId: "h1", epoch: 1, seq: 3 },
		]);
		const raw = await h.dailyRaw.get(BUCKET);
		// The marker is gone, the epoch moved past everything known, and the event landed.
		expect(raw?.stateCounts).toBeNull();
		expect(raw).toMatchObject({
			epoch: 2,
			seq: 4,
			state_paid: 1,
			state_pending: 1,
			revenueOrders: 2,
			revenueCents: 5500,
			refundEntries: 1,
			refundedCents: 250,
		});
		// The flat fields are authoritative: the old worker's state move is the under-count
		// residue a recompute heals, and nothing is counted twice.
		expect(await h.store.ordersByStatus(RANGE)).toEqual([
			{ status: "paid", orderCount: 1 },
			{ status: "pending", orderCount: 1 },
		]);
	});

	test("a recompute after the un-taint is exact, and the next one has nothing to write", async () => {
		const h = makeReportingHarness(bound.storage);
		await hybridDay(h);
		await h.refundOrder("h1", 250);

		const healed = await h.store.reconcile(RANGE);
		expect(healed.documentsWritten).toBe(1);
		expect(await h.daily.get(BUCKET)).toMatchObject({
			stateCounts: { paid: 2 },
			revenueOrders: 2,
			revenueCents: 5500,
			refundEntries: 1,
			refundedCents: 250,
		});
		const raw = await h.dailyRaw.get(BUCKET);
		expect(raw?.stateCounts).toBeNull();
		expect(raw).toMatchObject({ epoch: 3, state_paid: 2, state_pending: 0 });

		expect((await h.store.reconcile(RANGE)).documentsWritten).toBe(0);
		// And a live event after the heal is one delta on the healed document.
		await h.refundOrder("h2", 100);
		expect(await h.daily.get(BUCKET)).toMatchObject({
			stateCounts: { paid: 2 },
			refundEntries: 2,
			refundedCents: 350,
		});
	});
}
