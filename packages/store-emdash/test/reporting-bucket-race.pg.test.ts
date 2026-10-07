/**
 * One day document under a real crowd: the rollup's contention shape.
 *
 * It is **Postgres-required**: better-sqlite3 serializes writes in-process, so it can
 * verify the statements but cannot lose a race. Every order created on one day in one
 * currency shares ONE document, so a busy day is the hot document, and every checkout,
 * settle and refund that day writes to it. Four shapes are proven, all at N=200:
 *
 * 1. **N transitions into ONE bucket converge to the exact sum, with nobody refused.**
 *    If a losing writer's delta were ever applied against a value it had already read,
 *    the total would be short by exactly the peers it lost to. That is the failure a sum
 *    assertion catches and a spot check does not.
 * 2. **N first events on an ABSENT day document create it once and all land.** The
 *    create-if-absent is the one step where every writer genuinely races for the same
 *    slot, so it is where a crowd would first show up as a refusal.
 * 3. **A same-order stampede applies once.** N concurrent deliveries of ONE event (the
 *    retry storm a redelivered hook produces) leave one claim and one delta, because the
 *    claim is a create-if-absent and only one caller can win it.
 * 4. **Deltas racing a recompute never over-count.** A recompute commits an ABSOLUTE
 *    value while deltas land, so this is where a double count would appear. Whatever
 *    it leaves has to be the truth or an under-count, and a quiet recompute afterwards
 *    has to be exact.
 *
 * **The bound used to be the CROWD, and it no longer is.** The counters were moved by
 * read-modify-write compare-and-set, so a writer lost its revision once per peer that
 * committed ahead of it. That was measured at a depth of 12 at N=24. At N=200, on this
 * suite run against that code, 120 to 143 of the 200 transitions exhausted the 24-attempt
 * budget with `StorageContentionError`, as did 146 to 176 of the 250 first events and 47
 * of the 200 deltas racing a recompute. Each event is now ONE guarded numeric delta
 * (`updateIf`), which the database serializes on the row lock rather than refusing, so
 * the depth is 1 whatever the crowd. The depth assertion below is what keeps a
 * regression back to a read-modify-write loop from passing quietly.
 */
import { describe, expect, test } from "vitest";
import {
	isStorageContentionError,
	type ReportingDailyDoc,
	type ReportingOrderEvent,
} from "../src/index.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { settleOne } from "./helpers/fault-injection.js";
import { REPORTING_LAYOUT } from "./reporting-collections.js";
import { makeReportingHarness, type ReportingHarness } from "./reporting-harness.js";

const DAY = "2026-07-04T09:00:00.000Z";
const BUCKET = "USD:2026-07-04";
const RANGE = { from: "2026-07-04T00:00:00.000Z", to: "2026-07-04T23:59:59.999Z" };

/** The crowd. Two hundred writers, all on one document. */
const N = 200;

/**
 * The connection pool the crowd shares. Well under the server's default 100, leaving
 * room for anything else on the server, and still wide enough that dozens of writes are
 * genuinely in flight against the row at once rather than queued in the client.
 */
const POOL = 40;

interface Fixture {
	harness: ReportingHarness;
	/** The deepest attempt count one operation spent, or 0 if it never ran. */
	depth(operation: string): number;
	reset(): Promise<void>;
	close(): Promise<void>;
}

async function fresh(): Promise<Fixture> {
	const db = await makePgStorage(REPORTING_LAYOUT, POOL);
	const deepest = new Map<string, number>();
	const harness = makeReportingHarness(db.storage, {
		onCasAttempts: (operation, attempts) => {
			deepest.set(operation, Math.max(deepest.get(operation) ?? 0, attempts));
		},
	});
	return {
		harness,
		depth: (operation) => deepest.get(operation) ?? 0,
		reset: () => db.reset(),
		close: () => db.close(),
	};
}

/** The day document, read back through the store's own normalizer. */
async function bucket(h: ReportingHarness): Promise<ReportingDailyDoc> {
	const doc = await h.daily.get(BUCKET);
	if (doc === null) throw new Error("the day document is missing");
	return doc;
}

/** How many of a crowd's outcomes were a typed contention refusal. */
function contended(settled: unknown[]): number {
	return settled.filter((outcome) => isStorageContentionError(outcome)).length;
}

describe.skipIf(!PG_ENABLED)("reporting bucket contention [postgres]", () => {
	test("N=200 concurrent transitions into ONE day document converge to the exact sum, none refused", async () => {
		const LOOPS = 2;
		const fx = await fresh();
		try {
			for (let loop = 0; loop < LOOPS; loop++) {
				await fx.reset();
				const h = fx.harness;
				// Seeded serially: the race is the transitions, not the creations.
				let expected = 0;
				for (let i = 0; i < N; i++) {
					const total = 100 + i;
					expected += total;
					await h.seedOrder({
						id: `n${String(i)}`,
						state: "pending",
						currency: "USD",
						createdAt: DAY,
						totalCents: total,
					});
				}
				const events: ReportingOrderEvent[] = [];
				for (let i = 0; i < N; i++) events.push(await h.moveOrderDocument(`n${String(i)}`, "paid"));

				const settled = await Promise.all(
					events.map((event) => settleOne(h.store.recordOrderEvent(event))),
				);
				console.log(
					`[reporting bucket race] N=${String(N)} transitions: ${String(contended(settled))} refused, ` +
						`deepest attempt depth ${String(fx.depth("recordReportingEvent"))}`,
				);
				expect(contended(settled)).toBe(0);
				expect(settled.filter((outcome) => outcome instanceof Error)).toEqual([]);

				const doc = await bucket(h);
				expect(doc.revenueCents).toBe(expected);
				expect(doc.revenueOrders).toBe(N);
				expect(doc.stateCounts).toEqual({ paid: N });
				// ONE attempt each: nothing retried, whatever the crowd. A read-modify-write
				// loop would show here as a depth that grows with N.
				expect(fx.depth("recordReportingEvent")).toBe(1);
			}
		} finally {
			await fx.close();
		}
	}, 300_000);

	test("N=200 concurrent first events on an ABSENT day document create it once and all land", async () => {
		const fx = await fresh();
		try {
			await fx.reset();
			const h = fx.harness;
			// Arrivals straight into a revenue state, plus a refund against every fourth: the
			// day document does not exist yet, so every one of them races to create it.
			let revenue = 0;
			let refunded = 0;
			const events: ReportingOrderEvent[] = [];
			for (let i = 0; i < N; i++) {
				const total = 1000 + i;
				revenue += total;
				events.push({
					kind: "transition",
					orderId: `a${String(i)}`,
					orderCreatedAt: DAY,
					currency: "USD",
					fromState: null,
					toState: "paid",
					orderTotalCents: total,
				});
				if (i % 4 === 0) {
					refunded += 10 + i;
					events.push({
						kind: "refund",
						orderId: `a${String(i)}`,
						orderCreatedAt: DAY,
						currency: "USD",
						refundId: `r${String(i)}`,
						refundedCents: 10 + i,
					});
				}
			}
			const settled = await Promise.all(
				events.map((event) => settleOne(h.store.recordOrderEvent(event))),
			);
			console.log(
				`[reporting bucket race] N=${String(events.length)} first events on an absent document: ` +
					`${String(contended(settled))} refused, deepest attempt depth ` +
					`${String(fx.depth("recordReportingEvent"))}`,
			);
			expect(contended(settled)).toBe(0);
			expect(settled.filter((outcome) => outcome instanceof Error)).toEqual([]);
			// The one step every writer genuinely races on: a loser of the create-if-absent
			// re-reads once and finds the document, so the depth is bounded by 2 whatever N is.
			expect(fx.depth("ensureReportingDay")).toBeLessThanOrEqual(2);

			const doc = await bucket(h);
			expect(doc.stateCounts).toEqual({ paid: N });
			expect(doc.revenueOrders).toBe(N);
			expect(doc.revenueCents).toBe(revenue);
			expect(doc.refundEntries).toBe(N / 4);
			expect(doc.refundedCents).toBe(refunded);
			expect(Object.keys(await h.dailyDocs())).toEqual([BUCKET]);
		} finally {
			await fx.close();
		}
	}, 300_000);

	test("N=200 concurrent deliveries of ONE event apply it exactly once", async () => {
		const fx = await fresh();
		try {
			await fx.reset();
			const h = fx.harness;
			await h.seedOrder({
				id: "dup",
				state: "pending",
				currency: "USD",
				createdAt: DAY,
				totalCents: 5000,
			});
			const event = await h.moveOrderDocument("dup", "paid");
			const settled = await Promise.all(
				Array.from({ length: N }, () => settleOne(h.store.recordOrderEvent(event))),
			);
			expect(contended(settled)).toBe(0);
			expect(settled.filter((outcome) => outcome instanceof Error)).toEqual([]);
			const doc = await bucket(h);
			expect(doc.revenueCents).toBe(5000);
			expect(doc.stateCounts).toEqual({ paid: 1 });
			expect(await h.applied.get("dup:pending>paid")).not.toBeNull();
		} finally {
			await fx.close();
		}
	}, 300_000);

	test("N=200 deltas racing a recompute never over-count, and a quiet recompute is exact", async () => {
		const fx = await fresh();
		try {
			await fx.reset();
			const h = fx.harness;
			let expected = 0;
			for (let i = 0; i < N; i++) {
				const total = 100 + i;
				expected += total;
				await h.seedOrder({
					id: `r${String(i)}`,
					state: "pending",
					currency: "USD",
					createdAt: DAY,
					totalCents: total,
				});
			}
			const events: ReportingOrderEvent[] = [];
			for (let i = 0; i < N; i++) events.push(await h.moveOrderDocument(`r${String(i)}`, "paid"));

			// Recomputes run back to back for as long as the deltas are landing. A recompute
			// of a LIVE day may run out of attempts (every delta that lands moves the document
			// it pinned), which is its documented, typed and retryable outcome. What it may
			// never do is let a delta count on top of an absolute value that already had it.
			const race = { landing: true };
			const recomputes = (async () => {
				const outcomes: unknown[] = [];
				while (race.landing) outcomes.push(await settleOne(h.store.reconcile(RANGE)));
				return outcomes;
			})();
			// In waves, so the deltas keep landing for as long as several recomputes take,
			// rather than all finishing inside the first one's scan.
			const WAVE = 20;
			const settled: unknown[] = [];
			for (let at = 0; at < events.length; at += WAVE) {
				settled.push(
					...(await Promise.all(
						events.slice(at, at + WAVE).map((event) => settleOne(h.store.recordOrderEvent(event))),
					)),
				);
			}
			race.landing = false;
			const recomputed = await recomputes;
			expect(contended(settled)).toBe(0);
			expect(settled.filter((outcome) => outcome instanceof Error)).toEqual([]);
			expect(
				recomputed.filter(
					(outcome) => outcome instanceof Error && !isStorageContentionError(outcome),
				),
			).toEqual([]);

			// Mid-race, the document may lag the orders, never lead them: every order is in
			// exactly one bucket, and no more revenue is claimed than came in.
			const raced = await bucket(h);
			const counted = Object.values(raced.stateCounts).reduce((sum, count) => sum + count, 0);
			expect(counted).toBe(N);
			expect(raced.stateCounts.paid ?? 0).toBeLessThanOrEqual(N);
			expect(raced.revenueCents).toBeLessThanOrEqual(expected);
			expect(raced.revenueOrders).toBe(raced.stateCounts.paid ?? 0);

			// And the definition, once the day is quiet, is exact.
			await h.store.reconcile(RANGE);
			const healed = await bucket(h);
			expect(healed.stateCounts).toEqual({ paid: N });
			expect(healed.revenueCents).toBe(expected);
			console.log(
				`[reporting bucket race] N=${String(N)} deltas against ${String(recomputed.length)} ` +
					`concurrent recomputes (${String(contended(recomputed))} ran out of attempts, deepest ` +
					`${String(fx.depth("reconcileReportingDay"))} attempts); ` +
					`mid-race ${String(raced.stateCounts.paid ?? 0)}/${String(N)} counted paid`,
			);
		} finally {
			await fx.close();
		}
	}, 300_000);
});
