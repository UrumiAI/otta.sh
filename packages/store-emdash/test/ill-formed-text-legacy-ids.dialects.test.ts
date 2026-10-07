/**
 * Review round 2, A R2-A1: an id BUILT FROM a legacy document's stored text must
 * still reach the row it names.
 *
 * Several collections are keyed by text another document stores — inventory by
 * the sku a `reservation_index` entry carries, `emails` and `throttle` by an
 * email, reservation keys by an idempotency key. A document written before the
 * boundary existed can hold that text ill-formed. On SQLite it stays raw forever
 * (nothing heals there); on Postgres `get` reads it fine. Refusing every
 * ill-formed id made such a hold impossible to release — and the expiry sweep
 * that hit it stranded the stock for good. So only a method that can CREATE a row
 * refuses; one that addresses an existing row passes the id through, and behaves
 * as it did before the guard (Postgres's driver folds a lone surrogate to U+FFFD,
 * SQLite matches the raw row).
 */
import { idempotencyKey } from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import { afterEach, expect, test, vi } from "vitest";
import {
	collectionOf,
	EmdashInventoryStore,
	INVENTORY_COLLECTION,
	RESERVATION_INDEX_COLLECTION,
	type InventoryDoc,
	type ReservationIndexDoc,
	type StorageCollection,
} from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { INVENTORY_LAYOUT } from "./inventory-collections.js";

afterEach(() => {
	vi.restoreAllMocks();
});

let seq = 0;
const ids = { newId: () => `res-${String(++seq)}` };

describeEachDialect("ill-formed text: ids built from legacy stored text", (ctx) => {
	const bound = ctx.useStorage(INVENTORY_LAYOUT);
	const raw = <T>(name: string) => bound.storage[name] as StorageCollection<T>;

	test("a reservation whose stored sku is a legacy lone surrogate can still be released (A R2-A1 probe)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const store = new EmdashInventoryStore({
			storage: bound.storage,
			idGen: ids,
			clock: new FixedClock(new Date("2026-10-06T00:00:00.000Z")),
		});
		await store.seedOnHand("s�", 5);
		const reserved = await store.reserve("s�", 2, idempotencyKey("legacy-sku-hold"));
		if (!reserved.ok) throw new Error("arrange: reserve");
		const resId = reserved.reservationId;

		// The legacy shape: the index entry's sku as written before the boundary
		// existed. On SQLite the inventory row was keyed by that raw text too; on
		// Postgres the driver folded it into the U+FFFD row on the way in.
		const index = await raw<ReservationIndexDoc>(RESERVATION_INDEX_COLLECTION).get(resId);
		if (index === null) throw new Error("arrange: index");
		await raw<ReservationIndexDoc>(RESERVATION_INDEX_COLLECTION).put(resId, {
			...index,
			sku: "s\uD800",
		});
		if (ctx.dialect === "sqlite") {
			const inventory = raw<InventoryDoc>(INVENTORY_COLLECTION);
			const doc = await inventory.get("s�");
			if (doc === null) throw new Error("arrange: inventory");
			await inventory.put("s\uD800", { ...doc, sku: "s\uD800" });
			await inventory.delete("s�");
		}

		await expect(store.release(resId)).resolves.toBeUndefined();
		const after = await raw<ReservationIndexDoc>(RESERVATION_INDEX_COLLECTION).get(resId);
		expect(after?.terminalState).toBe("released");
		// The stock came back: a fresh guarded read of the row the legacy id names.
		const inventory = collectionOf<InventoryDoc>(bound.storage, INVENTORY_COLLECTION);
		const row = await inventory.get("s\uD800");
		expect(row).not.toBeNull();
	});
});
