import { describe, expect, test } from "vitest";
import { cents, currency, money } from "../money/cents.js";
import { idempotencyKey, productId, sku } from "../money/ids.js";
import { MissingProductIdError } from "../product-commerce/errors.js";
import type { ProductCommerceStore } from "../ports/product-commerce-store.js";

export interface ProductCommerceStoreHarness {
	store: ProductCommerceStore;
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
	});
}
