/**
 * Issue #631, the race tier: the `stranded-holds` release against a late payment.
 *
 * A payment can arrive for an order the leg is releasing, from another invocation
 * (the webhook) at the same instant. The leg must never return units that a settle
 * then commits. Two cases:
 *
 *  1. The real race. A late `settleOrder` for an EXPIRED order runs concurrently
 *     with the leg's unit on that order's sku. `expired` is terminal and `markPaid`
 *     is a guarded `pending → paid` flip, so the settle takes the late-payment path
 *     and commits nothing. The unit comes back on sale exactly once.
 *  2. The backstop. Even a commit racing the release on the SAME reservation (no
 *     production path does this for a dead order) cannot leave the units both sold
 *     and returned: the reservation's terminal state is first-wins, and the stock
 *     agrees with whichever write won.
 *
 * Postgres-only (`process.env.PG_CONNECTION_STRING`): SQLite serializes every
 * write, so it cannot race.
 */
import { orderId as toOrderId, settleOrder } from "@urumi.ai/otta-domain";
import { FakePaymentGateway } from "@urumi.ai/otta-domain/testing";
import {
	collectionOf,
	INVENTORY_COLLECTION,
	ORDERS_COLLECTION,
	RESERVATION_INDEX_COLLECTION,
	type InventoryDoc,
	type OrderDoc,
	type ReservationIndexDoc,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { makePgStorage } from "@urumi.ai/otta-store-emdash/testing";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createInProcessCommerceStores } from "../src/commerce/in-process-commerce-stores.js";
import { releaseStrandedOnSku } from "../src/cron/sweeps.js";
import { DAY_MS, HOUR_MS, placeOrder, strandOrder, sweepContext } from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const PG = process.env.PG_CONNECTION_STRING !== undefined;

/** Orders raced per case: enough interleavings to land both orders of the writes. */
const ROUNDS = 12;

describe.skipIf(!PG)("stranded-holds against a racing settle [postgres]", () => {
	let db: Awaited<ReturnType<typeof makePgStorage>> | undefined;
	let storage: StorageAccess;

	beforeAll(async () => {
		db = await makePgStorage(commerceStorageLayout());
		storage = db.storage;
	}, 120_000);

	afterAll(async () => {
		await db?.close();
	});

	const stores = () => createInProcessCommerceStores(sweepContext(storage));
	const inventoryDoc = async (sku: string) =>
		await collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION).get(sku);
	const terminalState = async (orderId: string) => {
		const order = await collectionOf<OrderDoc>(storage, ORDERS_COLLECTION).get(orderId);
		const id = order?.items[0]?.reservationId;
		if (typeof id !== "string") throw new Error("the order must carry its reservation");
		return (await collectionOf<ReservationIndexDoc>(storage, RESERVATION_INDEX_COLLECTION).get(id))
			?.terminalState;
	};
	const stranded = async (tag: string, state: "expired" | "cancelled") => {
		const now = new Date();
		const order = await placeOrder(
			storage,
			tag,
			new Date(now.getTime() + DAY_MS),
			new Date(now.getTime() - HOUR_MS),
		);
		await strandOrder(storage, order.id, state, now);
		return order;
	};

	test("a late payment settling an expired order commits nothing the release returns", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		for (let round = 0; round < ROUNDS; round++) {
			const tag = `late-${String(round)}-${crypto.randomUUID()}`;
			const order = await stranded(tag, "expired");
			const s = stores();
			const gateway = new FakePaymentGateway({ id: "stripe" });
			const doc = await inventoryDoc(order.sku);
			if (doc === null) throw new Error("the placed sku must exist");
			const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);

			const [settled, released] = await Promise.all([
				settleOrder(
					{
						orderStore: s.orderStore,
						entitlementStore: s.entitlementStore,
						paymentEventStore: s.paymentEventStore,
						inventoryStore: s.inventory,
						clock: s.clock,
					},
					gateway,
					gateway.webhook({
						outcome: "succeeded",
						orderId: order.id,
						providerRef: `pi_${tag}`,
						amount: 1000,
						currency: "USD",
						dedupeKey: `evt_${tag}`,
					}),
				),
				releaseStrandedOnSku(doc, orders, s),
			]);

			// The settle never paid the order: it stays expired.
			expect(settled.ok && settled.order?.state).not.toBe("paid");
			const after = await s.orderStore.getById(toOrderId(order.id));
			expect(after?.state).toBe("expired");
			// The release happened, once, and nothing committed the reservation.
			expect(released).toBe(1);
			expect(await terminalState(order.id)).toBe("released");
			const inv = await inventoryDoc(order.sku);
			expect(inv?.onHand).toBe(10);
			expect(Object.keys(inv?.holds ?? {})).toEqual([]);
		}
	}, 120_000);

	test("a commit racing the release on the same reservation: one wins, and the stock agrees with it", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		for (let round = 0; round < ROUNDS; round++) {
			const order = await stranded(`commit-${String(round)}-${crypto.randomUUID()}`, "cancelled");
			const s = stores();
			const doc = await inventoryDoc(order.sku);
			if (doc === null) throw new Error("the placed sku must exist");
			const placed = await collectionOf<OrderDoc>(storage, ORDERS_COLLECTION).get(order.id);
			const reservationId = placed?.items[0]?.reservationId;
			if (typeof reservationId !== "string") throw new Error("no reservation");

			await Promise.all([
				// A lost commit is the loud anomaly settle raises; the race is what is
				// under test, so it is caught here.
				s.inventory.commit(reservationId).catch(() => undefined),
				releaseStrandedOnSku(doc, collectionOf<OrderDoc>(storage, ORDERS_COLLECTION), s),
			]);

			const winner = await terminalState(order.id);
			expect(["committed", "released"]).toContain(winner);
			const inv = await inventoryDoc(order.sku);
			// Released: the unit is back (10). Committed: it is sold (9). Never 11, never
			// a hold left behind.
			expect(inv?.onHand).toBe(winner === "released" ? 10 : 9);
			expect(Object.keys(inv?.holds ?? {})).toEqual([]);
		}
		// Which side wins is the scheduler's choice, and either is safe: not asserted.
	}, 120_000);
});
