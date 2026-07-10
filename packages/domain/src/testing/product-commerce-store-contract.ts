import { describe, expect, test } from "vitest";
import { cents, currency, money } from "../money/cents.js";
import { idempotencyKey, productId, sku } from "../money/ids.js";
import { MissingProductIdError, SkuConflictError } from "../product-commerce/errors.js";
import type { ProductCommerceStore } from "../ports/product-commerce-store.js";

export interface ProductCommerceStoreHarness {
	store: ProductCommerceStore;
	/** Phase 2 (`listCommerceByIds`): seed the inventory `on_hand` the store's
	 *  intra-service `inStock` join reads — the dialect harness writes the real
	 *  `inventory` table; the fake harness feeds the fake's lookup. */
	seedStock(sku: string, qty: number): Promise<void>;
}

export interface ProductCommerceStoreContractOptions {
	dialect: string;
}

/**
 * The reusable behavioral spec for `ProductCommerceStore` (Phase 1 steps
 * 2–4), mirroring `inventoryStoreContract` (Phase 0 §0.3): the SAME suite
 * runs against the in-memory fake, then every store dialect. An adapter is
 * "done" the day it turns this suite green.
 *
 * `makeStore` returns a fresh, isolated store per invocation so cases never
 * share state.
 */
export function productCommerceStoreContract(
	makeStore: () => Promise<ProductCommerceStoreHarness>,
	opts: ProductCommerceStoreContractOptions,
): void {
	describe(`productCommerceStoreContract [${opts.dialect}]`, () => {
		test("upsert on an unknown product_id inserts a new row", async () => {
			const h = await makeStore();
			const pid = productId("prod-1");
			const row = await h.store.upsert(
				{
					productId: pid,
					sku: sku("SKU-1"),
					price: money(cents(1999), currency("USD")),
					productKind: "physical",
				},
				idempotencyKey("k1"),
			);

			expect(row.productId).toBe(pid);
			expect(row.sku).toBe("SKU-1");
			expect(row.price).toEqual({ amount: 1999, currency: "USD" });
			expect(row.productKind).toBe("physical");
			expect(row.active).toBe(false);
			expect(row.deletedAt).toBeNull();

			const read = await h.store.getByProductId(pid);
			expect(read).toEqual(row);
		});

		test("upsert on an existing product_id with a NEW key updates in place — no duplicate row", async () => {
			const h = await makeStore();
			const pid = productId("prod-2");
			await h.store.upsert(
				{ productId: pid, sku: sku("SKU-2"), price: money(cents(1000), currency("USD")) },
				idempotencyKey("k1"),
			);
			const updated = await h.store.upsert(
				{ productId: pid, sku: sku("SKU-2"), price: money(cents(2500), currency("USD")) },
				idempotencyKey("k2"),
			);

			expect(updated.price).toEqual({ amount: 2500, currency: "USD" });
			expect(updated.idempotencyKey).toBe("k2");

			const read = await h.store.getByProductId(pid);
			expect(read).toEqual(updated);
		});

		test("upsert preserves fields omitted (undefined) from the input and clears fields explicitly set to null", async () => {
			const h = await makeStore();
			const pid = productId("prod-3");
			await h.store.upsert(
				{
					productId: pid,
					sku: sku("SKU-3"),
					price: money(cents(500), currency("USD")),
					taxClass: "standard",
					weightGrams: 100,
				},
				idempotencyKey("k1"),
			);

			// Omitting sku/price/weightGrams preserves them; explicitly nulling
			// taxClass clears it.
			const updated = await h.store.upsert(
				{ productId: pid, taxClass: null },
				idempotencyKey("k2"),
			);

			expect(updated.sku).toBe("SKU-3");
			expect(updated.price).toEqual({ amount: 500, currency: "USD" });
			expect(updated.weightGrams).toBe(100);
			expect(updated.taxClass).toBeNull();
		});

		test("upsert replayed with the SAME idempotencyKey as the stored row is a no-op returning the existing row unchanged", async () => {
			const h = await makeStore();
			const pid = productId("prod-4");
			const first = await h.store.upsert(
				{ productId: pid, sku: sku("SKU-4"), price: money(cents(500), currency("USD")) },
				idempotencyKey("k1"),
			);

			// A replay carrying a DIFFERENT payload but the SAME key must not apply
			// the new payload — proof the compare-on-write dedupe looks at the key,
			// not the content.
			const replay = await h.store.upsert(
				{ productId: pid, sku: sku("SKU-4-CHANGED"), price: money(cents(999999), currency("USD")) },
				idempotencyKey("k1"),
			);

			expect(replay).toEqual(first);
			const read = await h.store.getByProductId(pid);
			expect(read).toEqual(first);
		});

		test("softDelete sets deletedAt + active=false and retains the row (never a hard delete)", async () => {
			const h = await makeStore();
			const pid = productId("prod-5");
			await h.store.upsert(
				{ productId: pid, sku: sku("SKU-5"), price: money(cents(500), currency("USD")) },
				idempotencyKey("k1"),
			);

			await h.store.softDelete(pid, idempotencyKey("del-1"));

			const read = await h.store.getByProductId(pid);
			expect(read).not.toBeNull();
			expect(read?.active).toBe(false);
			expect(read?.deletedAt).not.toBeNull();
			// Commercial data is preserved, never wiped, by a soft delete.
			expect(read?.sku).toBe("SKU-5");
			expect(read?.price).toEqual({ amount: 500, currency: "USD" });
		});

		test("softDelete is a stable no-op when replayed or called on an already-deleted row", async () => {
			const h = await makeStore();
			const pid = productId("prod-6");
			await h.store.upsert(
				{ productId: pid, sku: sku("SKU-6"), price: money(cents(500), currency("USD")) },
				idempotencyKey("k1"),
			);
			await h.store.softDelete(pid, idempotencyKey("del-1"));
			const firstDelete = await h.store.getByProductId(pid);

			await h.store.softDelete(pid, idempotencyKey("del-2"));
			const again = await h.store.getByProductId(pid);

			expect(again?.deletedAt).toEqual(firstDelete?.deletedAt);
		});

		test("softDelete on an unknown product_id is a no-op (no row minted)", async () => {
			const h = await makeStore();
			await h.store.softDelete(productId("does-not-exist"), idempotencyKey("del-1"));
			expect(await h.store.getByProductId(productId("does-not-exist"))).toBeNull();
		});

		test("upsert with a missing/empty product_id is rejected before any row is minted", async () => {
			const h = await makeStore();
			await expect(
				h.store.upsert(
					// Simulates a hand-crafted / mis-wired caller bypassing the branded
					// constructor — the store must still defend the invariant at runtime.
					{ productId: "" as ReturnType<typeof productId>, sku: sku("SKU-X") },
					idempotencyKey("k1"),
				),
			).rejects.toThrow(MissingProductIdError);
		});

		test("getByProductId on an unknown product_id returns null", async () => {
			const h = await makeStore();
			expect(await h.store.getByProductId(productId("nope"))).toBeNull();
		});

		test("upsert defaults productKind to physical when omitted, and preserves it on a later update", async () => {
			const h = await makeStore();
			const pid = productId("prod-7");
			const created = await h.store.upsert(
				{ productId: pid, sku: sku("SKU-7") },
				idempotencyKey("k1"),
			);
			expect(created.productKind).toBe("physical");

			const updated = await h.store.upsert(
				{ productId: pid, weightGrams: 250 },
				idempotencyKey("k2"),
			);
			expect(updated.productKind).toBe("physical");
			expect(updated.weightGrams).toBe(250);
		});

		// Review S1 — ordering: out-of-order sync delivery converges.
		test("a stale sync upsert (strictly older contentUpdatedAt) arriving after a newer one is a no-op returning the existing row unchanged", async () => {
			const h = await makeStore();
			const pid = productId("prod-8");
			const newer = await h.store.upsert(
				{
					productId: pid,
					sku: sku("SKU-8"),
					price: money(cents(2000), currency("USD")),
					contentUpdatedAt: "2026-07-10T02:00:00.000Z",
				},
				idempotencyKey("k-newer"),
			);

			// A DELAYED delivery of an OLDER save (different key, older
			// watermark, different payload) must not overwrite fresher data.
			const stale = await h.store.upsert(
				{
					productId: pid,
					price: money(cents(1), currency("USD")),
					contentUpdatedAt: "2026-07-10T01:00:00.000Z",
				},
				idempotencyKey("k-stale"),
			);

			expect(stale).toEqual(newer);
			const read = await h.store.getByProductId(pid);
			expect(read).toEqual(newer);
			// The stale key was NOT stamped onto the row.
			expect(read?.idempotencyKey).toBe("k-newer");
		});

		test("an equal-or-newer contentUpdatedAt applies; an upsert with no contentUpdatedAt (panel save) is last-writer-wins and preserves the stored watermark", async () => {
			const h = await makeStore();
			const pid = productId("prod-9");
			await h.store.upsert(
				{
					productId: pid,
					sku: sku("SKU-9"),
					price: money(cents(1000), currency("USD")),
					contentUpdatedAt: "2026-07-10T01:00:00.000Z",
				},
				idempotencyKey("k1"),
			);

			// Newer sync applies and advances the watermark.
			const newer = await h.store.upsert(
				{
					productId: pid,
					price: money(cents(1500), currency("USD")),
					contentUpdatedAt: "2026-07-10T02:00:00.000Z",
				},
				idempotencyKey("k2"),
			);
			expect(newer.price).toEqual({ amount: 1500, currency: "USD" });
			expect(newer.contentUpdatedAt).toBe("2026-07-10T02:00:00.000Z");

			// A panel save (no contentUpdatedAt) is explicit merchant intent:
			// last-writer-wins by design (the documented, accepted lost-update
			// semantics), and it preserves the stored watermark rather than
			// clearing it.
			const panel = await h.store.upsert(
				{ productId: pid, price: money(cents(1750), currency("USD")) },
				idempotencyKey("k3"),
			);
			expect(panel.price).toEqual({ amount: 1750, currency: "USD" });
			expect(panel.contentUpdatedAt).toBe("2026-07-10T02:00:00.000Z");
		});

		// Review S3 — soft-delete frees the SKU for reuse; live rows still contend.
		test("a SKU freed by soft-delete can be assigned to a new product; two LIVE products still cannot share a SKU", async () => {
			const h = await makeStore();
			const first = productId("prod-10a");
			const second = productId("prod-10b");
			await h.store.upsert(
				{ productId: first, sku: sku("SKU-10"), price: money(cents(500), currency("USD")) },
				idempotencyKey("k1"),
			);

			// While prod-10a is LIVE, a second product cannot take its sku — and
			// the failure is the STRUCTURED domain error (review F2), carrying
			// the contested sku, on every adapter.
			await expect(
				h.store.upsert({ productId: second, sku: sku("SKU-10") }, idempotencyKey("k2")),
			).rejects.toMatchObject({ name: "SkuConflictError", sku: "SKU-10" });
			await expect(
				h.store.upsert({ productId: second, sku: sku("SKU-10") }, idempotencyKey("k2b")),
			).rejects.toBeInstanceOf(SkuConflictError);

			// Soft-deleting the holder frees the sku for a new product…
			await h.store.softDelete(first, idempotencyKey("del-1"));
			const reused = await h.store.upsert(
				{ productId: second, sku: sku("SKU-10") },
				idempotencyKey("k3"),
			);
			expect(reused.sku).toBe("SKU-10");

			// …while the tombstoned row retains its own sku for order-history
			// integrity (soft delete never wipes commercial data).
			const tombstone = await h.store.getByProductId(first);
			expect(tombstone?.sku).toBe("SKU-10");
			expect(tombstone?.deletedAt).not.toBeNull();
		});

		// -- Phase 2: listCommerceByIds (batch catalog read, plan §6) -----------

		test("listCommerceByIds returns records for existing ids and omits missing ids", async () => {
			const h = await makeStore();
			const p1 = productId("prod-b1");
			const p2 = productId("prod-b2");
			await h.store.upsert(
				{ productId: p1, sku: sku("SKU-B1"), price: money(cents(1999), currency("USD")) },
				idempotencyKey("k1"),
			);
			await h.store.upsert(
				{ productId: p2, sku: sku("SKU-B2"), price: money(cents(500), currency("EUR")) },
				idempotencyKey("k2"),
			);
			await h.seedStock("SKU-B1", 5);

			const views = await h.store.listCommerceByIds([p1, p2, productId("prod-b-missing")]);

			// Missing ids are silently omitted — never an error, never a per-id
			// error entry ("no status-code-as-logic"; absence ⇒ purchasable:false
			// at the plugin's join). No order is guaranteed.
			expect(views).toHaveLength(2);
			expect(new Set(views.map((v) => v.productId))).toEqual(new Set([p1, p2]));
			const v1 = views.find((v) => v.productId === p1);
			expect(v1).toEqual({
				productId: p1,
				sku: "SKU-B1",
				price: { amount: 1999, currency: "USD" },
				inStock: true,
			});
		});

		test("listCommerceByIds computes inStock via the store's own inventory join: on_hand > 0 ⇒ true; 0 or no inventory row ⇒ false", async () => {
			const h = await makeStore();
			const stocked = productId("prod-b3");
			const drained = productId("prod-b4");
			const unseeded = productId("prod-b5");
			await h.store.upsert(
				{ productId: stocked, sku: sku("SKU-B3"), price: money(cents(100), currency("USD")) },
				idempotencyKey("k1"),
			);
			await h.store.upsert(
				{ productId: drained, sku: sku("SKU-B4"), price: money(cents(100), currency("USD")) },
				idempotencyKey("k2"),
			);
			await h.store.upsert(
				{ productId: unseeded, sku: sku("SKU-B5"), price: money(cents(100), currency("USD")) },
				idempotencyKey("k3"),
			);
			await h.seedStock("SKU-B3", 1);
			await h.seedStock("SKU-B4", 0);
			// SKU-B5 never seeded — no inventory row at all.

			const views = await h.store.listCommerceByIds([stocked, drained, unseeded]);

			const bySku = new Map(views.map((v) => [v.sku as string, v.inStock]));
			expect(bySku.get("SKU-B3")).toBe(true);
			expect(bySku.get("SKU-B4")).toBe(false);
			// A priced product with no inventory row still LISTS (it has commerce
			// data) — it is merely out of stock, coarsely (plan §8 risk 5).
			expect(bySku.get("SKU-B5")).toBe(false);
		});

		test("listCommerceByIds omits soft-deleted and commerce-incomplete (unpriced / sku-less) rows — absence, not an error", async () => {
			const h = await makeStore();
			const deleted = productId("prod-b6");
			const unpriced = productId("prod-b7");
			const skuless = productId("prod-b8");
			const live = productId("prod-b9");
			await h.store.upsert(
				{ productId: deleted, sku: sku("SKU-B6"), price: money(cents(100), currency("USD")) },
				idempotencyKey("k1"),
			);
			await h.store.softDelete(deleted, idempotencyKey("del-1"));
			// "Create, then price" not finished: a bare sync row with no price yet.
			await h.store.upsert({ productId: unpriced, sku: sku("SKU-B7") }, idempotencyKey("k2"));
			// Priced but no sku assigned yet — commerce-incomplete the other way.
			await h.store.upsert(
				{ productId: skuless, price: money(cents(100), currency("USD")) },
				idempotencyKey("k3"),
			);
			await h.store.upsert(
				{ productId: live, sku: sku("SKU-B9"), price: money(cents(100), currency("USD")) },
				idempotencyKey("k4"),
			);

			const views = await h.store.listCommerceByIds([deleted, unpriced, skuless, live]);

			expect(views.map((v) => v.productId)).toEqual([live]);
		});

		test("listCommerceByIds returns active=false rows — `active` is not a listing gate while afterPublish is deferred (Phase 1 handoff)", async () => {
			const h = await makeStore();
			const pid = productId("prod-b10");
			const row = await h.store.upsert(
				{ productId: pid, sku: sku("SKU-B10"), price: money(cents(100), currency("USD")) },
				idempotencyKey("k1"),
			);
			// Nothing sets active=true yet — every synced row is active=false.
			// Pin that the batch read does NOT gate on it (or the entire catalog
			// would render non-purchasable today).
			expect(row.active).toBe(false);

			const views = await h.store.listCommerceByIds([pid]);
			expect(views).toHaveLength(1);
		});

		test("listCommerceByIds with an empty id list returns [], and duplicate ids collapse to one record", async () => {
			const h = await makeStore();
			expect(await h.store.listCommerceByIds([])).toEqual([]);

			const pid = productId("prod-b11");
			await h.store.upsert(
				{ productId: pid, sku: sku("SKU-B11"), price: money(cents(100), currency("USD")) },
				idempotencyKey("k1"),
			);
			const views = await h.store.listCommerceByIds([pid, pid, pid]);
			expect(views).toHaveLength(1);
		});
	});
}
