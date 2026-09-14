/**
 * A recompute and a live event, interleaved deliberately — the two orderings that decide
 * whether write-time reporting can be trusted at all.
 *
 * A recompute commits an ABSOLUTE value and a live event commits a DELTA. Run them
 * against one day document without care and there are exactly two ways to be wrong: the
 * recompute can commit a value derived from a scan taken before the delta's order write,
 * overwriting a transition that really happened; or the delta can land on top of a
 * recompute that already counted it, counting the same money twice. Three mechanisms
 * close them, and each case here holds one of the two orderings open with the
 * fault-injection helper and asserts the exact total:
 *
 * 1. every day document is PINNED (its revision read) before the orders are scanned, so
 *    a delta landing in between costs the recompute its commit and forces a re-scan;
 * 2. the recompute ABSORBS the claims it reconstructed from the scanned orders before it
 *    commits any counter;
 * 3. the delta re-reads its claim immediately before every bucket write and skips itself
 *    when it has been absorbed.
 *
 * The parking is real storage, not a mock: the parked call is performed for real once
 * released, so what lands is what the host would have written.
 */
import type { DateRange } from "@otta-sh/domain";
import { expect, test } from "vitest";
import { REPORTING_APPLIED_COLLECTION, REPORTING_DAILY_COLLECTION } from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { isUpdateWrite, parkCall, withCollection } from "./helpers/fault-injection.js";
import { REPORTING_LAYOUT } from "./reporting-collections.js";
import { makeReportingHarness, type ReportingHarness } from "./reporting-harness.js";

const RANGE: DateRange = { from: "2026-07-01T00:00:00.000Z", to: "2026-07-31T23:59:59.999Z" };
const DAY = "2026-07-04T09:00:00.000Z";
const BUCKET = "USD:2026-07-04";

/** The day document's counters, or a thrown premise. */
async function bucket(h: ReportingHarness): Promise<{
	revenueCents: number;
	stateCounts: Record<string, number>;
}> {
	const doc = await h.daily.get(BUCKET);
	if (doc === null) throw new Error("the day document is missing");
	return { revenueCents: doc.revenueCents, stateCounts: doc.stateCounts };
}

describeEachDialect("EmdashReportingStore recompute interleaving", (ctx) => {
	const bound = ctx.useStorage(REPORTING_LAYOUT);

	test("a live transition landing between a recompute's scan and its commit is not overwritten", async () => {
		const h = makeReportingHarness(bound.storage);
		await h.seedOrder({
			id: "i1",
			state: "pending",
			currency: "USD",
			createdAt: DAY,
			totalCents: 4000,
		});
		await h.seedOrder({
			id: "i2",
			state: "pending",
			currency: "USD",
			createdAt: DAY,
			totalCents: 1000,
		});
		expect((await bucket(h)).stateCounts).toEqual({ pending: 2 });
		// i2's transition is durable but its rollup never landed, so the recompute has a
		// real correction to commit — a recompute that agrees with the document writes
		// nothing, and there would be no window to hold open.
		await h.moveOrderDocument("i2", "paid");

		// Park the recompute's own COMMIT — the read-modify-write on the day document —
		// so the window between its scan and its write is held open for a live event.
		const parked = parkCall(bound.collection(REPORTING_DAILY_COLLECTION), isUpdateWrite);
		const reconciler = makeReportingHarness(bound.storage, {
			clock: h.clock,
			storageForStore: withCollection(bound.storage, REPORTING_DAILY_COLLECTION, parked.collection),
		});
		const healing = reconciler.store.reconcile(RANGE);
		await parked.arrived;

		// i1 really becomes `paid` while the recompute is parked, and its delta lands.
		await h.transitionOrder("i1", "paid");
		expect(await bucket(h)).toEqual({ revenueCents: 4000, stateCounts: { paid: 1, pending: 1 } });

		parked.release();
		await healing;

		// The parked commit lost the revision it had pinned BEFORE its scan, re-scanned,
		// and committed a value that includes both transitions. Had it pinned after
		// scanning, it would have committed the value it was holding — i2 paid, i1 still
		// pending — and i1's transition would have been erased.
		expect(await bucket(h)).toEqual({ revenueCents: 5000, stateCounts: { paid: 2 } });
		expect(await h.store.revenueByPeriod(RANGE, "day")).toEqual([
			{
				bucketStart: "2026-07-04T00:00:00.000Z",
				currency: "USD",
				revenueCents: 5000,
				refundedCents: 0,
			},
		]);
	});

	test("a live delta parked between its claim and its bucket write does not double-count a recompute", async () => {
		const h = makeReportingHarness(bound.storage);
		await h.seedOrder({
			id: "i3",
			state: "pending",
			currency: "USD",
			createdAt: DAY,
			totalCents: 2500,
		});

		// The order really moves, then the live event's BUCKET write is parked — so the
		// claim exists, the counters have not moved, and a recompute runs to completion in
		// the gap. This is the ordering that double-counts without the absorbed marker.
		const event = await h.moveOrderDocument("i3", "paid");
		const parked = parkCall(bound.collection(REPORTING_DAILY_COLLECTION), isUpdateWrite);
		const live = makeReportingHarness(bound.storage, {
			clock: h.clock,
			storageForStore: withCollection(bound.storage, REPORTING_DAILY_COLLECTION, parked.collection),
		});
		const applying = live.store.recordOrderEvent(event);
		await parked.arrived;

		// The claim is there and the counters still say `pending`.
		expect(await h.applied.get("i3:pending>paid")).not.toBeNull();
		expect(await bucket(h)).toEqual({ revenueCents: 0, stateCounts: { pending: 1 } });

		await h.store.reconcile(RANGE);
		expect(await bucket(h)).toEqual({ revenueCents: 2500, stateCounts: { paid: 1 } });
		expect((await h.applied.get("i3:pending>paid"))?.absorbedAt).not.toBeNull();

		parked.release();
		await applying;

		// The parked delta re-read its claim, found it absorbed, and skipped itself.
		expect(await bucket(h)).toEqual({ revenueCents: 2500, stateCounts: { paid: 1 } });
	});

	test("a recompute absorbs only what its scan proves: a transition it never saw keeps its delta", async () => {
		const h = makeReportingHarness(bound.storage);
		await h.seedOrder({
			id: "i4",
			state: "pending",
			currency: "USD",
			createdAt: DAY,
			totalCents: 900,
		});

		// The recompute is parked on the claim write it is about to make — which happens
		// after its scan. The order then moves, which the scan never saw.
		const parked = parkCall(bound.collection(REPORTING_APPLIED_COLLECTION), () => true);
		const reconciler = makeReportingHarness(bound.storage, {
			clock: h.clock,
			storageForStore: withCollection(
				bound.storage,
				REPORTING_APPLIED_COLLECTION,
				parked.collection,
			),
		});
		const healing = reconciler.store.reconcile(RANGE);
		await parked.arrived;
		const event = await h.moveOrderDocument("i4", "paid");
		parked.release();
		await healing;

		// The claim the recompute absorbed is the arrival it DID see, not this transition.
		expect((await h.applied.get("i4:>pending"))?.absorbedAt).not.toBeNull();
		expect(await h.applied.get("i4:pending>paid")).toBeNull();

		// So the transition's delta still applies, and the total is exact.
		await h.store.recordOrderEvent(event);
		expect(await bucket(h)).toEqual({ revenueCents: 900, stateCounts: { paid: 1 } });
		// And a second recompute agrees with the delta stream.
		await h.store.reconcile(RANGE);
		expect(await bucket(h)).toEqual({ revenueCents: 900, stateCounts: { paid: 1 } });
	});

	test("many live events and a recompute, interleaved, agree on the exact totals", async () => {
		const h = makeReportingHarness(bound.storage);
		let expected = 0;
		for (let i = 0; i < 6; i++) {
			const total = 100 * (i + 1);
			expected += total;
			await h.seedOrder({
				id: `m${String(i)}`,
				state: "pending",
				currency: "USD",
				createdAt: DAY,
				totalCents: total,
			});
		}
		// Half the transitions land, then a recompute runs, then the rest land.
		for (let i = 0; i < 3; i++) await h.transitionOrder(`m${String(i)}`, "paid");
		await h.store.reconcile(RANGE);
		for (let i = 3; i < 6; i++) await h.transitionOrder(`m${String(i)}`, "paid");
		expect(await bucket(h)).toEqual({ revenueCents: expected, stateCounts: { paid: 6 } });
		// A recompute after them all changes nothing.
		await h.store.reconcile(RANGE);
		expect(await bucket(h)).toEqual({ revenueCents: expected, stateCounts: { paid: 6 } });
	});
});
