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
import { afterEach, describe, expect, test, vi } from "vitest";
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
	const bound = ctx.useStorage({
		...INVENTORY_LAYOUT,
		products: { indexes: ["title"] },
		owners: {},
	});
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

	describe("a write never re-keys a legacy sku (#447, from #415 item 1)", () => {
		// `inventory` and `sku_owners` are keyed by the raw sku a product document
		// stores. On SQLite and D1 a legacy row keeps that raw text as its id
		// forever, so a write that "repaired" the product's `sku` field would point
		// it at a row that does not exist: stock lookups miss and new holds throw.
		// On Postgres the driver already folded the id to U+FFFD on the way in, so
		// the repaired field is exactly the id's spelling — and Postgres must repair,
		// or its `jsonb` cannot read the document. Either way: the sku a write leaves
		// behind still addresses the row it named before.
		const LEGACY_SKU = "s\uD800";
		const products = () => collectionOf<{ title: string; sku: string }>(bound.storage, "products");
		const owners = () => collectionOf<{ productId: string }>(bound.storage, "owners");

		async function arrangeLegacy(): Promise<void> {
			// Written past the guard, the way a row written before it was.
			await raw<{ title: string; sku: string }>("products").put("p1", {
				title: "old",
				sku: LEGACY_SKU,
			});
			await raw<{ productId: string }>("owners").put(LEGACY_SKU, { productId: "p1" });
		}

		async function expectSkuStillAddressesItsRow(): Promise<void> {
			const product = await products().get("p1");
			if (product === null) throw new Error("product vanished");
			expect(product.title).toBe("new");
			expect(await owners().get(product.sku)).toEqual({ productId: "p1" });
			if (ctx.dialect === "sqlite") {
				// Nothing to repair for on this dialect: the text is stored as written.
				expect(product.sku).toBe(LEGACY_SKU);
			} else {
				// Postgres stores the folded spelling, and the collection stays queryable.
				expect(product.sku).toBe("s\uFFFD");
				expect(await products().count({ title: "new" })).toBe(1);
			}
		}

		test("compareAndSet of an unrelated field", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			await arrangeLegacy();
			const current = await products().getVersioned("p1");
			if (current === null) throw new Error("arrange");
			const written = await products().compareAndSet("p1", current.revision, {
				...current.value,
				title: "new",
			});
			expect(written.applied).toBe(true);
			await expectSkuStillAddressesItsRow();
		});

		test("put of the whole document", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			await arrangeLegacy();
			const current = await products().get("p1");
			if (current === null) throw new Error("arrange");
			await products().put("p1", { ...current, title: "new" });
			await expectSkuStillAddressesItsRow();
		});

		test("updateIf setting the sku field back to the value it read", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			await arrangeLegacy();
			const current = await products().get("p1");
			if (current === null) throw new Error("arrange");
			const result = await products().updateIf("p1", {
				where: { title: "old" },
				set: { title: "new", sku: current.sku },
			});
			expect(result.applied).toBe(true);
			await expectSkuStillAddressesItsRow();
		});
	});
});
