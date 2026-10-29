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
 *     A REGRESSION GUARD: no interleaving exists in which that settle commits, so
 *     this case pins the reasoning rather than racing two writers on one row.
 *  2. The backstop. Even a commit racing the release on the SAME reservation (no
 *     production path does this for a dead order) cannot leave the units both sold
 *     and returned: the reservation's terminal state is first-wins, and the stock
 *     and the leg's count agree with whichever write won. Both orders are forced
 *     (`parkFirst`), so each path is proven to run, and then raced unordered.
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
			expect(released).toEqual({ released: 1 });
			expect(await terminalState(order.id)).toBe("released");
			const inv = await inventoryDoc(order.sku);
			expect(inv?.onHand).toBe(10);
			expect(Object.keys(inv?.holds ?? {})).toEqual([]);
		}
	}, 120_000);

	const reservationOf = async (orderId: string): Promise<string> => {
		const placed = await collectionOf<OrderDoc>(storage, ORDERS_COLLECTION).get(orderId);
		const id = placed?.items[0]?.reservationId;
		if (typeof id !== "string") throw new Error("no reservation");
		return id;
	};

	test("commit wins: the release that read the hold live and lost the terminal write returns nothing", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const order = await stranded(`commit-first-${crypto.randomUUID()}`, "cancelled");
		const reservationId = await reservationOf(order.id);
		const doc = await inventoryDoc(order.sku);
		if (doc === null) throw new Error("the placed sku must exist");
		// The release reads the index live, then waits at its terminal write while the
		// commit runs to the end: its write then finds the commit's.
		let commitDone!: () => void;
		const committed = new Promise<void>((resolve) => (commitDone = resolve));
		const parked = parkFirst(storage, RESERVATION_INDEX_COLLECTION, "compareAndSet", committed);
		const leg = createInProcessCommerceStores(sweepContext(parked.storage));
		const releasing = releaseStrandedOnSku(
			doc,
			collectionOf<OrderDoc>(storage, ORDERS_COLLECTION),
			leg,
		);
		// The release has read the index live and is waiting at its terminal write.
		await parked.arrived;
		await stores().inventory.commit(reservationId);
		commitDone();
		expect(await releasing).toEqual({ released: 0 });
		expect(await terminalState(order.id)).toBe("committed");
		const inv = await inventoryDoc(order.sku);
		expect(inv?.onHand).toBe(9);
		expect(Object.keys(inv?.holds ?? {})).toEqual([]);
	}, 120_000);

	test("release wins: the commit that read the hold live and lost the terminal write is the loud anomaly", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const order = await stranded(`release-first-${crypto.randomUUID()}`, "cancelled");
		const reservationId = await reservationOf(order.id);
		const doc = await inventoryDoc(order.sku);
		if (doc === null) throw new Error("the placed sku must exist");
		let releaseDone!: () => void;
		const releasedFirst = new Promise<void>((resolve) => (releaseDone = resolve));
		const parked = parkFirst(storage, RESERVATION_INDEX_COLLECTION, "compareAndSet", releasedFirst);
		const committer = createInProcessCommerceStores(sweepContext(parked.storage));
		const committing = committer.inventory.commit(reservationId).then(
			() => "committed",
			(err: unknown) => (err instanceof Error ? err.name : "error"),
		);
		// The commit has read the hold live and is waiting at its terminal write.
		await parked.arrived;
		const visit = await releaseStrandedOnSku(
			doc,
			collectionOf<OrderDoc>(storage, ORDERS_COLLECTION),
			stores(),
		);
		releaseDone();
		expect(visit).toEqual({ released: 1 });
		expect(await committing).toBe("ReservationCommitLostError");
		expect(await terminalState(order.id)).toBe("released");
		const inv = await inventoryDoc(order.sku);
		expect(inv?.onHand).toBe(10);
		expect(Object.keys(inv?.holds ?? {})).toEqual([]);
	}, 120_000);

	test("unordered, a commit racing the release: the winner decides the stock and the count", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		for (let round = 0; round < ROUNDS; round++) {
			const order = await stranded(`commit-${String(round)}-${crypto.randomUUID()}`, "cancelled");
			const s = stores();
			const doc = await inventoryDoc(order.sku);
			if (doc === null) throw new Error("the placed sku must exist");
			const reservationId = await reservationOf(order.id);

			const [, visit] = await Promise.all([
				// A lost commit is the loud anomaly settle raises; caught here.
				s.inventory.commit(reservationId).catch(() => undefined),
				releaseStrandedOnSku(doc, collectionOf<OrderDoc>(storage, ORDERS_COLLECTION), s),
			]);

			const winner = await terminalState(order.id);
			expect(["committed", "released"]).toContain(winner);
			const inv = await inventoryDoc(order.sku);
			// Released: the unit is back (10) and counted. Committed: it is sold (9) and
			// not counted. Never 11, never a hold left behind.
			expect(inv?.onHand).toBe(winner === "released" ? 10 : 9);
			expect(visit.released).toBe(winner === "released" ? 1 : 0);
			expect(Object.keys(inv?.holds ?? {})).toEqual([]);
		}
	}, 120_000);
});

/** `base`, with the FIRST `method` call on `collection` held until `until` settles —
 *  how a case fixes which of two racers writes first. `arrived` resolves when that
 *  call is parked, so the case knows the racer is really waiting there. */
function parkFirst(
	base: StorageAccess,
	collection: string,
	method: string,
	until: Promise<void>,
): { storage: StorageAccess; arrived: Promise<void> } {
	const target = base[collection];
	if (target === undefined) throw new Error(`no ${collection} collection`);
	let parked = false;
	let arrive!: () => void;
	const arrived = new Promise<void>((resolve) => (arrive = resolve));
	const storage: StorageAccess = {
		...base,
		[collection]: new Proxy(target, {
			get(t, prop, receiver) {
				const value: unknown = Reflect.get(t, prop, receiver);
				if (prop !== method || typeof value !== "function") return value;
				return async (...args: unknown[]) => {
					if (!parked) {
						parked = true;
						arrive();
						await until;
					}
					return (value as (...a: unknown[]) => Promise<unknown>).apply(t, args);
				};
			},
		}),
	};
	return { storage, arrived };
}
