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
	cents,
	currency,
	idempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	reservationId as toReservationId,
	sku as toSku,
} from "@urumi.ai/otta-domain";
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
	for (const state of ["expired", "cancelled", "failed"] as const) {
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

	test("a hold whose order document is gone is left alone, and the walk goes on", async () => {
		const gone = await adoptedOrder("stranded-gone");
		await collectionOf<OrderDoc>(storage, ORDERS_COLLECTION).delete(gone.id);
		const later = await adoptedOrder("stranded-after-gone");
		await strandOrder(storage, later.id, "expired", NOW);
		const leg = strandedLeg(await tick(await onlyStrandedHoldsDue()));
		expect(leg).toMatchObject({ ok: true, count: 1 });
		expect(await heldStates(gone.sku)).toEqual(["adopted"]);
		expect(await onHand(later.sku)).toBe(10);
	});

	test("a clean pass ends the repair: the next run costs one read and walks nothing", async () => {
		const order = await adoptedOrder("stranded-done");
		await strandOrder(storage, order.id, "cancelled", NOW);
		const cursors = await onlyStrandedHoldsDue();
		expect(strandedLeg(await tick(cursors)).count).toBe(1);
		// That pass released one: not yet done.
		expect(JSON.parse((await cursors.read("stranded-holds")) ?? "{}").done ?? null).toBeNull();
		await dueAgain(cursors);
		expect(strandedLeg(await tick(cursors)).count).toBe(0);
		// A whole pass that released nothing: done.
		expect(JSON.parse((await cursors.read("stranded-holds")) ?? "{}").done).toBe(NOW.toISOString());
		// A hold stranded now (it cannot be, after #629) is not looked for any more.
		const late = await adoptedOrder("stranded-after-done");
		await strandOrder(storage, late.id, "cancelled", NOW);
		await dueAgain(cursors);
		const after = strandedLeg(await tick(cursors));
		expect(after).toMatchObject({ ok: true, count: 0 });
		// No inventory page, no order read: only the cursor read, and this suite's
		// injected cursor store is not metered (in production it is one kv read).
		expect(after.queries).toBe(0);
		expect(await heldStates(late.sku)).toEqual(["adopted"]);
	});

	test("a sku whose order read throws is stepped past and the rotation is not marked done", async () => {
		const bad = await adoptedOrder("stranded-bad");
		await strandOrder(storage, bad.id, "cancelled", NOW);
		const good = await adoptedOrder("stranded-good");
		await strandOrder(storage, good.id, "cancelled", NOW);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const cursors = await onlyStrandedHoldsDue();
		const leg = strandedLeg(
			await runCommerceSweeps(sweepContext(failingOrderRead(storage, bad.id)), SWEEP_TASK_NAME, {
				cursors,
				emailSender: recordingSender([]),
				now: NOW,
				queryBudget: 600,
			}),
		);
		expect(leg).toMatchObject({ ok: true, count: 1 });
		expect(await heldStates(bad.sku)).toEqual(["adopted"]);
		expect(await onHand(good.sku)).toBe(10);
		const cursor = JSON.parse((await cursors.read("stranded-holds")) ?? "{}");
		expect(cursor.done ?? null).toBeNull();
		// The next rotation, with the read healthy, gets it.
		await dueAgain(cursors);
		expect(strandedLeg(await tick(cursors)).count).toBe(1);
		expect(await onHand(bad.sku)).toBe(10);
	});
});

describe("stranded-holds on the Workers Free preset (queryBudget 30)", () => {
	/** A pending order adopting one unit of `sku` (seeded with ten on first use). */
	async function placeOnSku(sku: string, tag: string, createdAt: Date): Promise<string> {
		const s = adapters(storage, createdAt);
		const holdExpiresAt = new Date(NOW.getTime() + DAY_MS);
		await s.inventory.seedOnHand(toSku(sku), 10);
		const held = await s.inventory.reserve(toSku(sku), 1, idempotencyKey(`res-${tag}`));
		if (!held.ok) throw new Error(`could not reserve: ${held.reason}`);
		await s.inventory.stampHoldDeadline(
			held.reservationId,
			new Date(holdExpiresAt.getTime() + DAY_MS).toISOString(),
		);
		const id = `order-${tag}`;
		await s.inventory.adoptMany({
			reservationIds: [held.reservationId],
			orderId: toOrderId(id),
			holdExpiresAt: holdExpiresAt.toISOString(),
			now: createdAt.toISOString(),
		});
		await s.orderStore.createFromCart({
			orderId: toOrderId(id),
			cartId: `cart-${tag}`,
			currency: currency("USD"),
			idempotencyKey: idempotencyKey(`create-${tag}`),
			holdExpiresAt: holdExpiresAt.toISOString(),
			buyerRef: `buyer-${tag}@example.test`,
			paymentMethod: "stripe",
			lines: [
				{
					productId: toProductId(`prod-${tag}`),
					sku: toSku(sku),
					title: "Free Widget",
					unitPrice: cents(1000),
					currency: currency("USD"),
					quantity: 1,
					fulfillmentKind: "physical",
					reservationId: toReservationId(held.reservationId),
				},
			],
			totals: { subtotal: cents(1000), total: cents(1000), currency: currency("USD") },
		});
		return id;
	}

	async function freeTicks(n: number): Promise<number> {
		const cursors = await onlyStrandedHoldsDue();
		let released = 0;
		for (let t = 0; t < n; t++) {
			await dueAgain(cursors);
			const leg = strandedLeg(
				await runCommerceSweeps(sweepContext(storage), SWEEP_TASK_NAME, {
					cursors,
					emailSender: recordingSender([]),
					now: NOW,
					queryBudget: 30,
				}),
			);
			expect(leg.ok, leg.error).toBe(true);
			released += leg.count;
		}
		return released;
	}

	test("several stranded orders on one sku, and a later sku, all heal", async () => {
		// The reviewer's probe: four on AAA-HOT used to stall the walk there forever.
		for (let i = 0; i < 4; i++) {
			const id = await placeOnSku(
				"AAA-HOT",
				`hot-${String(i)}`,
				new Date(NOW.getTime() - HOUR_MS + i * 1000),
			);
			await strandOrder(storage, id, "cancelled", NOW);
		}
		const later = await placeOnSku(
			"ZZZ-LATER",
			"later",
			new Date(NOW.getTime() - HOUR_MS + 60_000),
		);
		await strandOrder(storage, later, "cancelled", NOW);

		expect(await freeTicks(12)).toBe(5);
		expect(await onHand("AAA-HOT")).toBe(10);
		expect(await onHand("ZZZ-LATER")).toBe(10);
	});

	test("a hot sku held by many live checkouts does not stall the walk", async () => {
		// More orders on one sku than one Free tick can read: the sku is worked
		// through over ticks, from the last order judged.
		for (let i = 0; i < 9; i++) {
			await placeOnSku(
				"AAA-BUSY",
				`busy-${String(i)}`,
				new Date(NOW.getTime() - HOUR_MS + i * 1000),
			);
		}
		const later = await placeOnSku(
			"ZZZ-AFTER-BUSY",
			"after-busy",
			new Date(NOW.getTime() - HOUR_MS + 60_000),
		);
		await strandOrder(storage, later, "expired", NOW);

		expect(await freeTicks(12)).toBe(1);
		expect(await onHand("ZZZ-AFTER-BUSY")).toBe(10);
		// The live checkouts keep their holds.
		expect(await onHand("AAA-BUSY")).toBe(1);
		expect(await heldStates("AAA-BUSY")).toEqual(Array.from({ length: 9 }, () => "adopted"));
	});
});

/** The cadence state with every other slow-cadence leg just run, rewritten so
 *  `stranded-holds` is due on the next tick. */
async function dueAgain(cursors: ReturnType<typeof memoryCursors>): Promise<void> {
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
}

/** `base`, with one order's read failing — a corrupt row, a transient error. */
function failingOrderRead(base: StorageAccess, orderId: string): StorageAccess {
	const orders = base[ORDERS_COLLECTION];
	if (orders === undefined) throw new Error("orders collection missing");
	return {
		...base,
		[ORDERS_COLLECTION]: new Proxy(orders, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (prop !== "get" || typeof value !== "function") return value;
				return async (id: string) => {
					if (id === orderId) throw new Error("injected order read failure");
					return (value as (id: string) => Promise<unknown>).call(target, id);
				};
			},
		}),
	};
}
