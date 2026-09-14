/**
 * One day document under a real crowd — the rollup's contention shape.
 *
 * It is **Postgres-required**: better-sqlite3 serializes writes in-process, so it can
 * verify the statements but cannot lose a race. Two shapes are proven:
 *
 * 1. **N transitions into ONE bucket converge to the exact sum.** Every order created
 *    on one day in one currency shares a single document, so a busy day is the hot
 *    document, and the counters are moved by read-modify-write compare-and-set — there
 *    is no nested-path guarded update to lean on. If a losing writer's delta were ever
 *    applied against a value it had already read, the total would be short by exactly
 *    the peers it lost to, which is the failure a sum assertion catches and a spot
 *    check does not.
 * 2. **A same-order stampede applies once.** N concurrent deliveries of ONE event —
 *    the retry storm a redelivered hook produces — leave one claim and one delta,
 *    because the claim is a create-if-absent and only one caller can win it.
 *
 * The bound on this document is the CROWD, not the document: nothing here refuses
 * anybody (every distinct event legitimately moves a counter), so a writer can lose
 * its revision once per peer that commits ahead of it. That is the shipping/tax-rules
 * shape, which is why the crowd is 24 rather than larger — see `CAS_MAX_ATTEMPTS`.
 */
import { describe, expect, test } from "vitest";
import { CAS_MAX_ATTEMPTS, isStorageContentionError } from "../src/index.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { settleOne } from "./helpers/fault-injection.js";
import { REPORTING_LAYOUT } from "./reporting-collections.js";
import { makeReportingHarness, type ReportingHarness } from "./reporting-harness.js";

const DAY = "2026-07-04T09:00:00.000Z";
const BUCKET = "USD:2026-07-04";

interface Fixture {
	harness: ReportingHarness;
	maxAttempts(): number;
	reset(): Promise<void>;
	close(): Promise<void>;
}

async function fresh(poolMax: number): Promise<Fixture> {
	const db = await makePgStorage(REPORTING_LAYOUT, poolMax);
	let deepest = 0;
	const harness = makeReportingHarness(db.storage, {
		onCasAttempts: (_operation, attempts) => {
			deepest = Math.max(deepest, attempts);
		},
	});
	return {
		harness,
		maxAttempts: () => deepest,
		reset: () => db.reset(),
		close: () => db.close(),
	};
}

describe.skipIf(!PG_ENABLED)("reporting bucket contention [postgres]", () => {
	test("N concurrent transitions into ONE day document converge to the exact sum", async () => {
		const N = 24;
		const LOOPS = 4;
		const fx = await fresh(N + 4);
		try {
			for (let loop = 0; loop < LOOPS; loop++) {
				await fx.reset();
				const h = fx.harness;
				// Seeded serially: the race is the transitions, not the creations.
				const totals: number[] = [];
				for (let i = 0; i < N; i++) {
					const total = 100 + i;
					totals.push(total);
					await h.seedOrder({
						id: `n${String(i)}`,
						state: "pending",
						currency: "USD",
						createdAt: DAY,
						totalCents: total,
					});
				}
				const events = [];
				for (let i = 0; i < N; i++) events.push(await h.moveOrderDocument(`n${String(i)}`, "paid"));

				const settled = await Promise.all(
					events.map((event) => settleOne(h.store.recordOrderEvent(event))),
				);
				// A contention refusal is a typed, retryable outcome under the documented
				// budget — but at this crowd size none is expected, and one would mean the
				// budget is too tight for a busy day rather than that the sum is wrong.
				expect(settled.filter((outcome) => isStorageContentionError(outcome))).toHaveLength(0);

				const doc = await h.daily.get(BUCKET);
				expect(doc?.revenueCents).toBe(totals.reduce((sum, t) => sum + t, 0));
				expect(doc?.stateCounts).toEqual({ paid: N });
				expect(fx.maxAttempts()).toBeLessThanOrEqual(CAS_MAX_ATTEMPTS);
			}
			// Reported rather than only bounded: the depth IS the contention measurement.
			console.log(`[reporting bucket race] deepest compare-and-set depth: ${String(fx.maxAttempts())}`);
		} finally {
			await fx.close();
		}
	}, 120_000);

	test("N concurrent deliveries of ONE event apply it exactly once", async () => {
		const N = 16;
		const fx = await fresh(N + 4);
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
			expect(settled.filter((outcome) => isStorageContentionError(outcome))).toHaveLength(0);
			const doc = await h.daily.get(BUCKET);
			expect(doc?.revenueCents).toBe(5000);
			expect(doc?.stateCounts).toEqual({ paid: 1 });
			expect(await h.applied.get("dup:pending>paid")).not.toBeNull();
		} finally {
			await fx.close();
		}
	}, 120_000);
});
