/**
 * The seam between the two documents a rollup event writes — the claim that makes
 * it once-only, and the day document that holds the counters.
 *
 * There is no transaction, so a process can die between them, and which one is
 * written first decides what the survivor looks like. The claim is written FIRST
 * and deliberately: a crash after it leaves the event claimed and the counters
 * short, which is an UNDER-count — a report that says less money than came in,
 * never more, and never one order counted in two state buckets at once. The
 * recompute is what restores exactness (ADR-0019's cross-cutting rule (c): the
 * guard is responsible for never being wrong in the dangerous direction, the
 * sweeper for eventually being exact).
 *
 * Every case reads the documents back before healing, so the state the recompute
 * repairs is the state the store really leaves behind rather than one the test
 * assumed. The order document always moves FIRST — that is the order the hook runs
 * in, and it is why the orders can always define the answer.
 */
import type { DateRange } from "@otta-sh/domain";
import { expect, test } from "vitest";
import { REPORTING_APPLIED_COLLECTION, REPORTING_DAILY_COLLECTION } from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { failCall, InjectedCrashError, withCollection } from "./helpers/fault-injection.js";
import { REPORTING_LAYOUT } from "./reporting-collections.js";
import { makeReportingHarness, type ReportingHarness } from "./reporting-harness.js";

const RANGE: DateRange = { from: "2026-07-01T00:00:00.000Z", to: "2026-07-31T23:59:59.999Z" };
const DAY = "2026-07-04T09:00:00.000Z";
const BUCKET = "USD:2026-07-04";

/** A pending order on 2026-07-04, rolled up as the live path would. */
async function seedPending(h: ReportingHarness, id: string, total: number): Promise<void> {
	await h.seedOrder({ id, state: "pending", currency: "USD", createdAt: DAY, totalCents: total });
}

/** The one day document this file works on. */
async function bucket(h: ReportingHarness): Promise<{
	revenueCents: number;
	refundedCents: number;
	stateCounts: Record<string, number>;
} | null> {
	const doc = await h.daily.get(BUCKET);
	return doc === null
		? null
		: {
				revenueCents: doc.revenueCents,
				refundedCents: doc.refundedCents,
				stateCounts: doc.stateCounts,
			};
}

/** A twin whose every write to one collection dies, sharing the origin's clock. */
function crashingOn(
	h: ReportingHarness,
	storage: Parameters<typeof withCollection>[0],
	raw: Parameters<typeof withCollection>[2],
	collection: string,
	mode: "after" | "instead",
): ReportingHarness {
	const failing = failCall(raw, () => true, { mode, once: false });
	return makeReportingHarness(storage, {
		clock: h.clock,
		storageForStore: withCollection(storage, collection, failing.collection),
	});
}

describeEachDialect("EmdashReportingStore crash seams", (ctx) => {
	const bound = ctx.useStorage(REPORTING_LAYOUT);

	test("a crash between the claim and the counters leaves the claim, an under-count, and a recompute that repairs it", async () => {
		const h = makeReportingHarness(bound.storage);
		await seedPending(h, "c1", 4000);
		await h.transitionOrder("c1", "paid");
		await seedPending(h, "c2", 2500);
		expect(await bucket(h)).toEqual({
			revenueCents: 4000,
			refundedCents: 0,
			stateCounts: { paid: 1, pending: 1 },
		});

		// c2 really becomes `paid` — the order document is the truth — and the counter
		// write that should follow never happens.
		const crashed = crashingOn(
			h,
			bound.storage,
			bound.collection(REPORTING_DAILY_COLLECTION),
			REPORTING_DAILY_COLLECTION,
			"instead",
		);
		const event = await h.moveOrderDocument("c2", "paid");
		await expect(crashed.store.recordOrderEvent(event)).rejects.toThrow(InjectedCrashError);

		// The residue, read back: the claim is there and UN-stamped, the counters are
		// short by exactly the lost event, and the report under-states rather than
		// double-counting.
		const claim = await h.applied.get("c2:pending>paid");
		expect(claim).not.toBeNull();
		expect(claim?.appliedAt).toBeNull();
		expect(await bucket(h)).toEqual({
			revenueCents: 4000,
			refundedCents: 0,
			stateCounts: { paid: 1, pending: 1 },
		});
		expect(await h.store.revenueByPeriod(RANGE, "day")).toEqual([
			{
				bucketStart: "2026-07-04T00:00:00.000Z",
				currency: "USD",
				revenueCents: 4000,
				refundedCents: 0,
			},
		]);

		// The heal.
		await h.store.reconcile(RANGE);
		expect(await bucket(h)).toEqual({
			revenueCents: 6500,
			refundedCents: 0,
			stateCounts: { paid: 2 },
		});
		expect((await h.applied.get("c2:pending>paid"))?.appliedAt).not.toBeNull();

		// And the lost event, redelivered after the heal, is a no-op rather than a
		// second 2500.
		await h.store.recordOrderEvent(event);
		expect((await bucket(h))?.revenueCents).toBe(6500);
	});

	test("a crash AFTER the counters landed does not let the event apply twice", async () => {
		const h = makeReportingHarness(bound.storage);
		await seedPending(h, "c3", 1000);
		await h.transitionOrder("c3", "paid");
		await seedPending(h, "c4", 300);

		// `mode: "after"` performs the real write and then throws: the counters land,
		// and the caller never learns that they did.
		const crashed = crashingOn(
			h,
			bound.storage,
			bound.collection(REPORTING_DAILY_COLLECTION),
			REPORTING_DAILY_COLLECTION,
			"after",
		);
		const event = await h.moveOrderDocument("c4", "paid");
		await expect(crashed.store.recordOrderEvent(event)).rejects.toThrow(InjectedCrashError);

		// The write DID land, and the claim proves the event is spent.
		expect((await bucket(h))?.revenueCents).toBe(1300);
		expect(await h.applied.get("c4:pending>paid")).not.toBeNull();

		// The crashed caller's own retry must not add 300 again.
		await h.store.recordOrderEvent(event);
		expect((await bucket(h))?.revenueCents).toBe(1300);
		// And the recompute agrees with what is already there.
		await h.store.reconcile(RANGE);
		expect(await bucket(h)).toEqual({
			revenueCents: 1300,
			refundedCents: 0,
			stateCounts: { paid: 2 },
		});
	});

	test("a crash BEFORE the claim applies nothing, and the redelivery applies it exactly once", async () => {
		const h = makeReportingHarness(bound.storage);
		await seedPending(h, "c5", 700);
		await h.transitionOrder("c5", "paid");
		await seedPending(h, "c6", 900);

		const crashed = crashingOn(
			h,
			bound.storage,
			bound.collection(REPORTING_APPLIED_COLLECTION),
			REPORTING_APPLIED_COLLECTION,
			"instead",
		);
		const event = await h.moveOrderDocument("c6", "paid");
		await expect(crashed.store.recordOrderEvent(event)).rejects.toThrow(InjectedCrashError);
		expect(await h.applied.get("c6:pending>paid")).toBeNull();
		expect((await bucket(h))?.revenueCents).toBe(700);

		await h.store.recordOrderEvent(event);
		expect((await bucket(h))?.revenueCents).toBe(1600);
		await h.store.recordOrderEvent(event);
		expect((await bucket(h))?.revenueCents).toBe(1600);
	});

	test("a transition whose rollup is lost leaves the order counted in its OLD state until the recompute", async () => {
		const h = makeReportingHarness(bound.storage);
		await seedPending(h, "c7", 5000);
		expect((await bucket(h))?.stateCounts).toEqual({ pending: 1 });

		const crashed = crashingOn(
			h,
			bound.storage,
			bound.collection(REPORTING_DAILY_COLLECTION),
			REPORTING_DAILY_COLLECTION,
			"instead",
		);
		const event = await h.moveOrderDocument("c7", "paid");
		await expect(crashed.store.recordOrderEvent(event)).rejects.toThrow(InjectedCrashError);
		// Stale in the under-counting direction: no revenue is claimed for an order
		// that has in fact been paid.
		expect(await bucket(h)).toEqual({
			revenueCents: 0,
			refundedCents: 0,
			stateCounts: { pending: 1 },
		});

		await h.store.reconcile(RANGE);
		expect(await bucket(h)).toEqual({
			revenueCents: 5000,
			refundedCents: 0,
			stateCounts: { paid: 1 },
		});
	});

	test("a crash AFTER the claim landed leaves a permanent under-count, and only a recompute lifts it", async () => {
		const h = makeReportingHarness(bound.storage);
		await seedPending(h, "c9", 600);
		await h.transitionOrder("c9", "paid");
		await seedPending(h, "c10", 1500);

		// The claim write itself succeeds and THEN the caller dies: the event is spent
		// before a single counter moved. This is the residue the claim-first ordering
		// chooses, and it is why it is an under-count rather than a double count.
		const crashed = crashingOn(
			h,
			bound.storage,
			bound.collection(REPORTING_APPLIED_COLLECTION),
			REPORTING_APPLIED_COLLECTION,
			"after",
		);
		const event = await h.moveOrderDocument("c10", "paid");
		await expect(crashed.store.recordOrderEvent(event)).rejects.toThrow(InjectedCrashError);
		expect(await h.applied.get("c10:pending>paid")).not.toBeNull();
		expect((await bucket(h))?.revenueCents).toBe(600);

		// The redelivery finds the claim and does nothing: the gap does NOT close itself,
		// whoever retries and however often.
		await h.store.recordOrderEvent(event);
		await h.store.recordOrderEvent(event);
		expect(await bucket(h)).toEqual({
			revenueCents: 600,
			refundedCents: 0,
			stateCounts: { paid: 1, pending: 1 },
		});

		// Only the recompute lifts it.
		await h.store.reconcile(RANGE);
		expect(await bucket(h)).toEqual({
			revenueCents: 2100,
			refundedCents: 0,
			stateCounts: { paid: 2 },
		});
	});

	test("money with no contributing order left is still reported, and a floored counter is announced", async () => {
		const anomalies: { counter: string; docId: string; orderId: string }[] = [];
		const h = makeReportingHarness(bound.storage, {
			onAnomaly: (anomaly) => {
				anomalies.push({
					counter: anomaly.counter,
					docId: anomaly.docId,
					orderId: anomaly.orderId,
				});
			},
		});
		await seedPending(h, "c11", 5000);
		await h.transitionOrder("c11", "paid");

		// A transition OUT of a revenue state for an order the document never counted in —
		// the shape a lost increment leaves. It takes the day's one contributor out of the
		// revenue count while money it cannot account for stays behind.
		await h.store.recordOrderEvent({
			kind: "transition",
			orderId: "c12",
			orderCreatedAt: DAY,
			currency: "USD",
			fromState: "paid",
			toState: "cancelled",
			orderTotalCents: 1000,
		});
		const doc = await h.daily.get(BUCKET);
		expect(doc?.revenueOrders).toBe(0);
		expect(doc?.revenueCents).toBe(4000);

		// The bucket must NOT vanish: a filter keyed only on the contributor counts would
		// drop a day that is holding 4000.
		expect(await h.store.revenueByPeriod(RANGE, "day")).toEqual([
			{
				bucketStart: "2026-07-04T00:00:00.000Z",
				currency: "USD",
				revenueCents: 4000,
				refundedCents: 0,
			},
		]);

		// And a decrement that really does hit the floor is announced rather than silently
		// clamped — flooring is proof of drift, so it has to reach an operator.
		await h.store.recordOrderEvent({
			kind: "transition",
			orderId: "c13",
			orderCreatedAt: DAY,
			currency: "USD",
			fromState: "delivered",
			toState: "cancelled",
			orderTotalCents: 700,
		});
		expect(anomalies.map((anomaly) => anomaly.counter)).toContain("stateCounts.delivered");
		expect(anomalies.map((anomaly) => anomaly.counter)).toContain("revenueOrders");
		expect(anomalies.every((anomaly) => anomaly.docId === BUCKET)).toBe(true);
		expect(anomalies.every((anomaly) => anomaly.orderId === "c13")).toBe(true);
	});

	test("a lost REFUND rollup is healed into the day the ORDER was created, never the day it was issued", async () => {
		const h = makeReportingHarness(bound.storage);
		await seedPending(h, "c8", 8000);
		await h.transitionOrder("c8", "paid");
		// Time moves on by a fortnight; the refund is issued in a different bucket.
		h.advance(14 * 86_400_000);

		const crashed = crashingOn(
			h,
			bound.storage,
			bound.collection(REPORTING_DAILY_COLLECTION),
			REPORTING_DAILY_COLLECTION,
			"instead",
		);
		const event = await h.addRefundDocument("c8", 2000);
		await expect(crashed.store.recordOrderEvent(event)).rejects.toThrow(InjectedCrashError);
		expect((await bucket(h))?.refundedCents).toBe(0);

		await h.store.reconcile(RANGE);
		expect(await bucket(h)).toEqual({
			revenueCents: 8000,
			refundedCents: 2000,
			stateCounts: { paid: 1 },
		});
		// Nothing was written into the day the refund was issued in.
		expect(await h.daily.get("USD:2026-07-18")).toBeNull();
	});
});
