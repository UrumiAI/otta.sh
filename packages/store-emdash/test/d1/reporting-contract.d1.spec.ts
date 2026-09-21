/**
 * The reporting contract against the rollup adapter on **D1** — the dialect Otta
 * actually ships on, through the host's OWN Kysely wiring.
 *
 * The contract runs in full, with no skips. What this tier exercises that the others
 * cannot is the READ contract every report depends on, planned by D1's SQLite build:
 * the `date` RANGE plus the `orderBy` on the same field that pages the day documents,
 * and the `createdAt` range the line-snapshot and recompute scans bind. Each is a
 * `json_extract` expression with the host's own limit clamp and cursor on top, and a
 * declared index is a read contract rather than a performance knob — so this is where
 * that contract meets the runtime that will serve it.
 *
 * One crash seam runs with it: the claim lands, the counters do not, and the recompute
 * restores exactness. The harness wiring is `test/reporting-harness.ts`, imported
 * rather than restated — it names no Node driver, so it loads inside `workerd`.
 */
import { reportingStoreContract } from "@otta-sh/domain/testing";
import { expect, test } from "vitest";
import { REPORTING_DAILY_COLLECTION } from "../../src/index.js";
import { failCall, InjectedCrashError, withCollection } from "../helpers/fault-injection.js";
import { REPORTING_LAYOUT } from "../reporting-collections.js";
import { makeReportingHarness } from "../reporting-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(REPORTING_LAYOUT);

reportingStoreContract(async () => makeReportingHarness(bound.storage), { dialect: "d1" });

test("a crash between the claim and the counters under-counts, and the recompute repairs it", async () => {
	const h = makeReportingHarness(bound.storage);
	const day = "2026-07-04T09:00:00.000Z";
	await h.seedOrder({
		id: "d1a",
		state: "pending",
		currency: "USD",
		createdAt: day,
		totalCents: 1200,
	});

	const failing = failCall(bound.collection(REPORTING_DAILY_COLLECTION), () => true, {
		mode: "instead",
		once: false,
	});
	const crashed = makeReportingHarness(bound.storage, {
		clock: h.clock,
		storageForStore: withCollection(bound.storage, REPORTING_DAILY_COLLECTION, failing.collection),
	});
	const event = await h.moveOrderDocument("d1a", "paid");
	await expect(crashed.store.recordOrderEvent(event)).rejects.toThrow(InjectedCrashError);

	expect((await h.applied.get("d1a:pending>paid"))?.appliedAt).toBeNull();
	expect((await h.daily.get("USD:2026-07-04"))?.stateCounts).toEqual({ pending: 1 });

	await h.store.reconcile({ from: "2026-07-01T00:00:00.000Z", to: "2026-07-31T23:59:59.999Z" });
	const healed = await h.daily.get("USD:2026-07-04");
	expect(healed?.stateCounts).toEqual({ paid: 1 });
	expect(healed?.revenueCents).toBe(1200);
	// The redelivered event is spent, not a second 1200.
	await h.store.recordOrderEvent(event);
	expect((await h.daily.get("USD:2026-07-04"))?.revenueCents).toBe(1200);
});
