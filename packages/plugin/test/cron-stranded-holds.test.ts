/**
 * Issue #631: the `stranded-holds` leg returns units still `adopted` by an order
 * that is already expired or cancelled.
 *
 * Before #629, the recovery sweep could adopt a checkout's holds for an order a
 * cancel (or the expiry) had already moved on. That order's own release ran while
 * the holds were still cart-`held`, so it released nothing and stamped its intent
 * complete. The holds stayed `adopted`, with `holdsPendingAt` null, so no sweep
 * visited the order again. Hold expiry skips adopted holds, so the units stayed off
 * sale for good. #629 stops new cases; this leg returns the ones already stranded.
 *
 * Every case seeds a real order over a real adopted reservation through the store
 * adapters, then writes the order document as a stranded pre-#629 order looks: a
 * terminal state, every intent complete, `holdsPendingAt` null.
 */
import {
	collectionOf,
	INVENTORY_COLLECTION,
	ORDERS_COLLECTION,
	type InventoryDoc,
	type OrderDoc,
	RESERVATION_INDEX_COLLECTION,
	type ReservationIndexDoc,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { makeSqliteStorage } from "@urumi.ai/otta-store-emdash/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { runCommerceSweeps, SWEEP_TASK_NAME } from "../src/cron/index.js";
import { MAINTENANCE_LEGS, type CommerceSweepSummary } from "../src/cron/sweeps.js";
import {
	adapters,
	DAY_MS,
	HOUR_MS,
	memoryCursors,
	placeOrder,
	recordingSender,
	strandOrder,
	sweepContext,
} from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");

let storage: StorageAccess;

beforeEach(async () => {
	({ storage } = await makeSqliteStorage(commerceStorageLayout()));
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
}, 120_000);

/** Cursors with every OTHER slow-cadence leg just run, so this tick's only scan
 *  is `stranded-holds`. */
async function onlyStrandedHoldsDue(): Promise<ReturnType<typeof memoryCursors>> {
	const cursors = memoryCursors();
	await cursors.write(
		"state",
		JSON.stringify({
			lastRun: Object.fromEntries(
				MAINTENANCE_LEGS.filter((leg) => leg !== "stranded-holds").map((leg) => [
					leg,
					NOW.toISOString(),
				]),
			),
		}),
	);
	return cursors;
}

async function tick(cursors: ReturnType<typeof memoryCursors>): Promise<CommerceSweepSummary> {
	return await runCommerceSweeps(sweepContext(storage), SWEEP_TASK_NAME, {
		cursors,
		emailSender: recordingSender([]),
		now: NOW,
		queryBudget: 600,
	});
}

function strandedLeg(summary: CommerceSweepSummary) {
	const leg = summary.legs.find((entry) => entry.leg === "stranded-holds");
	if (leg === undefined) throw new Error("the stranded-holds leg must be in the summary");
	return leg;
}

async function onHand(sku: string): Promise<number> {
	const doc = await collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION).get(sku);
	return doc?.onHand ?? Number.NaN;
}

async function heldStates(sku: string): Promise<string[]> {
	const doc = await collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION).get(sku);
	return Object.values(doc?.holds ?? {}).map((hold) => hold.state);
}

/** The terminal state of the order's one reservation, from `reservation_index`. */
async function terminalStateOf(orderId: string): Promise<string | undefined> {
	const order = await collectionOf<OrderDoc>(storage, ORDERS_COLLECTION).get(orderId);
	const id = order?.items[0]?.reservationId;
	if (typeof id !== "string") throw new Error("the order must carry its reservation");
	const index = await collectionOf<ReservationIndexDoc>(storage, RESERVATION_INDEX_COLLECTION).get(
		id,
	);
	return index?.terminalState;
}

/** A pending order adopting one unit of a sku seeded with ten. */
async function adoptedOrder(tag: string): Promise<{ id: string; sku: string }> {
	return await placeOrder(
		storage,
		tag,
		new Date(NOW.getTime() + DAY_MS),
		new Date(NOW.getTime() - HOUR_MS),
	);
}

describe("stranded-holds: units adopted by a dead order go back on sale (#631)", () => {
	for (const state of ["expired", "cancelled"] as const) {
		test(`a hold still adopted by a ${state} order is released and its unit restored`, async () => {
			const order = await adoptedOrder(`stranded-${state}`);
			expect(await onHand(order.sku)).toBe(9);
			await strandOrder(storage, order.id, state, NOW);

			const summary = await tick(await onlyStrandedHoldsDue());

			const leg = strandedLeg(summary);
			expect(leg.ok, leg.error).toBe(true);
			expect(leg.count).toBe(1);
			expect(await onHand(order.sku)).toBe(10);
			expect(await heldStates(order.sku)).toEqual([]);
			expect(await terminalStateOf(order.id)).toBe("released");
			// The order itself is not touched.
			const after = await collectionOf<OrderDoc>(storage, ORDERS_COLLECTION).get(order.id);
			expect(after?.state).toBe(state);
			expect(console.warn).toHaveBeenCalledWith(
				expect.stringContaining(`${state} order ${order.id} (#631)`),
			);
		});
	}

	test("a hold adopted by a paid order is left alone", async () => {
		const order = await adoptedOrder("stranded-paid");
		// The paid order's commit is still owed — the crash window `hold-intents` closes —
		// but that is the commit's work, never a release.
		await adapters(storage, new Date(NOW.getTime() - HOUR_MS)).orderStore.markPaid(
			order.id as never,
		);
		const cursors = await onlyStrandedHoldsDue();
		// Pin the state so `hold-intents` cannot commit it first: only the scan runs.
		const summary = await runCommerceSweeps(sweepContext(storage), SWEEP_TASK_NAME, {
			cursors,
			emailSender: recordingSender([]),
			now: NOW,
			queryBudget: 600,
			legBodies: { "hold-intents": async () => 0 },
		});

		expect(strandedLeg(summary)).toMatchObject({ ok: true, count: 0 });
		expect(await onHand(order.sku)).toBe(9);
		expect(await heldStates(order.sku)).toEqual(["adopted"]);
	});

	test("a hold adopted by a live pending order is left alone", async () => {
		const order = await adoptedOrder("stranded-pending");
		const summary = await tick(await onlyStrandedHoldsDue());
		expect(strandedLeg(summary)).toMatchObject({ ok: true, count: 0 });
		expect(await onHand(order.sku)).toBe(9);
		expect(await heldStates(order.sku)).toEqual(["adopted"]);
	});

	test("an expired order whose release intent is still outstanding is left to hold-intents", async () => {
		// Mid-transition: the order owes its own release. `hold-intents` owns that
		// work, so this leg does not race it.
		const order = await adoptedOrder("stranded-midway");
		await strandOrder(storage, order.id, "expired", NOW, { releaseOutstanding: true });
		const summary = await runCommerceSweeps(sweepContext(storage), SWEEP_TASK_NAME, {
			cursors: await onlyStrandedHoldsDue(),
			emailSender: recordingSender([]),
			now: NOW,
			queryBudget: 600,
			legBodies: { "hold-intents": async () => 0 },
		});
		expect(strandedLeg(summary)).toMatchObject({ ok: true, count: 0 });
		expect(await heldStates(order.sku)).toEqual(["adopted"]);
	});

	test("a second run changes nothing", async () => {
		const order = await adoptedOrder("stranded-rerun");
		await strandOrder(storage, order.id, "cancelled", NOW);
		const cursors = await onlyStrandedHoldsDue();
		expect(strandedLeg(await tick(cursors)).count).toBe(1);
		expect(await onHand(order.sku)).toBe(10);

		// Due again: the slow cadence's stamp cleared, the cursor kept.
		await cursors.write(
			"state",
			JSON.stringify({
				lastRun: Object.fromEntries(
					MAINTENANCE_LEGS.filter((leg) => leg !== "stranded-holds").map((leg) => [
						leg,
						NOW.toISOString(),
					]),
				),
			}),
		);
		const again = strandedLeg(await tick(cursors));
		expect(again).toMatchObject({ ok: true, count: 0 });
		expect(again.incomplete).toBeUndefined();
		expect(await onHand(order.sku)).toBe(10);
		expect(await heldStates(order.sku)).toEqual([]);
	});

	test("the walk resumes from its cursor across ticks and reaches every sku", async () => {
		const orders = [];
		for (let i = 0; i < 5; i++) {
			const order = await adoptedOrder(`stranded-walk-${String(i)}`);
			await strandOrder(storage, order.id, "expired", NOW);
			orders.push(order);
		}
		const cursors = await onlyStrandedHoldsDue();
		let released = 0;
		for (let run = 0; run < 10 && released < 5; run++) {
			await cursors.write("state", JSON.stringify({ lastRun: {} }));
			const summary = await runCommerceSweeps(sweepContext(storage), SWEEP_TASK_NAME, {
				cursors,
				emailSender: recordingSender([]),
				now: NOW,
				queryBudget: 600,
				// Two rows a page: the walk must carry its place over the page seam.
				pageSize: 2,
				maxPages: 1,
			});
			released += strandedLeg(summary).count;
		}
		expect(released).toBe(5);
		for (const order of orders) expect(await onHand(order.sku)).toBe(10);
	});
});
