/**
 * The rollup's two equivalences: a recompute agrees with the live event stream,
 * and applying an event twice is applying it once.
 *
 * These are the properties that make write-time reporting honest. The live path
 * moves counters by DELTAS — a transition decrements the state bucket an order is
 * leaving and increments the one it enters, in the day the order was CREATED,
 * however long ago that was — and a delta stream has no way to notice that it has
 * drifted. So the recompute is the definition and the delta stream is the fast
 * path: `reconcile` rebuilds every day document in a window from the orders
 * themselves, and the claim documents are what keep a redelivered event from
 * moving a counter a second time.
 *
 * The event sequence is pseudo-random from a FIXED seed, so a failure is
 * reproducible and the shape is not one a hand-written sequence happens to avoid.
 */
import { expect, test } from "vitest";
import type { DateRange } from "@otta-sh/domain";
import {
	isScanPageLimitError,
	type ReportingDailyDoc,
	type ReportingOrderEvent,
} from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { REPORTING_LAYOUT } from "./reporting-collections.js";
import { makeReportingHarness, type ReportingHarness } from "./reporting-harness.js";

/** The window every case in this file reconciles over. */
const RANGE: DateRange = { from: "2026-06-25T00:00:00.000Z", to: "2026-07-05T23:59:59.999Z" };

/** A deterministic 0..1 source — a fixed-seed LCG, so a failure reproduces. */
function lcg(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state / 2_147_483_648;
	};
}

/** The legal onward chains a seeded `pending` order can walk. */
const CHAINS: string[][] = [
	["paid", "processing", "shipped", "delivered", "completed"],
	["paid", "refunded"],
	["failed"],
	["expired"],
	["cancelled"],
	["paid", "processing"],
];

const CURRENCIES = ["USD", "EUR"];

/**
 * 18 orders spread over the window, each walked some distance down a chain and
 * some of them refunded. Returns every event in the order it was applied.
 */
async function driveSequence(
	h: ReportingHarness,
	seed = 20_260_914,
): Promise<ReportingOrderEvent[]> {
	const rand = lcg(seed);
	const events: ReportingOrderEvent[] = [];
	for (let i = 0; i < 18; i++) {
		const day = 25 + Math.floor(rand() * 11); // 2026-06-25 .. 2026-07-05
		const at = new Date(Date.UTC(2026, 5, day, 1 + Math.floor(rand() * 20))).toISOString();
		const id = `r${String(i)}`;
		const currency = CURRENCIES[Math.floor(rand() * CURRENCIES.length)] ?? "USD";
		const total = 500 + Math.floor(rand() * 9500);
		await h.seedOrder({ id, state: "pending", currency, createdAt: at, totalCents: total });
		// The creation event the seed emitted, restated so a replay can re-issue it.
		events.push({
			kind: "transition",
			orderId: id,
			orderCreatedAt: at,
			currency,
			fromState: null,
			toState: "pending",
			orderTotalCents: total,
		});
		const chain = CHAINS[Math.floor(rand() * CHAINS.length)] ?? [];
		const steps = Math.floor(rand() * (chain.length + 1));
		for (let step = 0; step < steps; step++) {
			const to = chain[step];
			if (to === undefined) break;
			h.advance(3_600_000);
			events.push(await h.transitionOrder(id, to));
		}
		const refunds = Math.floor(rand() * 3);
		for (let r = 0; r < refunds; r++) {
			h.advance(600_000);
			events.push(await h.refundOrder(id, 1 + Math.floor(rand() * total)));
		}
	}
	return events;
}

/** The rollup documents with the write stamp dropped — the stamp is not the value. */
function values(docs: Record<string, ReportingDailyDoc>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [id, doc] of Object.entries(docs)) {
		const { updatedAt: _stamp, ...rest } = doc;
		out[id] = JSON.stringify(rest);
	}
	return out;
}

describeEachDialect("EmdashReportingStore replay equivalence", (ctx) => {
	const bound = ctx.useStorage(REPORTING_LAYOUT);

	test("a recompute over the window changes nothing the live events wrote", async () => {
		const h = makeReportingHarness(bound.storage);
		await driveSequence(h);
		const live = values(await h.dailyDocs());
		expect(Object.keys(live).length).toBeGreaterThan(4);
		await h.store.reconcile(RANGE);
		expect(values(await h.dailyDocs())).toEqual(live);
	});

	test("a recompute rebuilds every document the live events wrote, after they are lost", async () => {
		const h = makeReportingHarness(bound.storage);
		await driveSequence(h);
		const live = values(await h.dailyDocs());

		// Lose every rollup — the disaster case the recompute exists for. The orders
		// are untouched, and they are the definition.
		for (const id of Object.keys(live)) await h.daily.delete(id);
		expect(await h.dailyDocs()).toEqual({});

		await h.store.reconcile(RANGE);
		expect(values(await h.dailyDocs())).toEqual(live);
	});

	test("applying every event a SECOND time changes nothing", async () => {
		const h = makeReportingHarness(bound.storage);
		const events = await driveSequence(h);
		const live = values(await h.dailyDocs());
		for (const event of events) await h.store.recordOrderEvent(event);
		expect(values(await h.dailyDocs())).toEqual(live);
		// And a third time, out of order, is still nothing.
		for (const event of events.toReversed()) await h.store.recordOrderEvent(event);
		expect(values(await h.dailyDocs())).toEqual(live);
	});

	test("a replay AFTER a recompute does not double-apply: the recompute leaves the claims it folded in", async () => {
		const h = makeReportingHarness(bound.storage);
		const events = await driveSequence(h);
		// Lose the claims as well as the counters, so the recompute has to re-establish
		// both — this is the state a rollup collection restored from nothing is in.
		for (const id of Object.keys(await h.dailyDocs())) await h.daily.delete(id);
		let cursor: string | undefined;
		for (;;) {
			const page = await h.applied.query({ limit: 100, cursor });
			for (const row of page.items) await h.applied.delete(row.id);
			if (!page.hasMore || page.cursor === undefined) break;
			cursor = page.cursor;
		}

		await h.store.reconcile(RANGE);
		const healed = values(await h.dailyDocs());
		for (const event of events) await h.store.recordOrderEvent(event);
		expect(values(await h.dailyDocs())).toEqual(healed);
	});

	test("a recompute that cannot afford its scan throws ScanPageLimitError instead of scanning", async () => {
		// What is asserted is the REFUSAL, not the absence of a partial rebuild: the budget
		// is per day, and a day that cannot afford its own scan writes nothing at all, so
		// a range whose later days run out leaves the earlier days committed. That residue
		// is real and documented with the others; it is not what this case pins.
		const h = makeReportingHarness(bound.storage);
		await driveSequence(h);
		const tight = makeReportingHarness(bound.storage, {
			maxReconcilePages: 0,
			clock: h.clock,
		});
		const failure = await tight.store.reconcile(RANGE).then(
			() => null,
			(err: unknown) => err,
		);
		expect(isScanPageLimitError(failure)).toBe(true);
		expect((failure as { budgetOption: string }).budgetOption).toBe("maxReconcilePages");
	});

	test("the reads agree with the rollups the sequence produced, before and after a recompute", async () => {
		const h = makeReportingHarness(bound.storage);
		await driveSequence(h);
		const revenue = await h.store.revenueByPeriod(RANGE, "day");
		const statuses = await h.store.ordersByStatus(RANGE);
		await h.store.reconcile(RANGE);
		expect(await h.store.revenueByPeriod(RANGE, "day")).toEqual(revenue);
		expect(await h.store.ordersByStatus(RANGE)).toEqual(statuses);
		// The status counts cover every seeded order exactly once.
		expect(statuses.reduce((sum, s) => sum + s.orderCount, 0)).toBe(18);
	});
});
