import { describe, expect, test } from "vitest";
import { cents, currency, money } from "../money/cents.js";
import { idempotencyKey, productId, sku } from "../money/ids.js";
import { MissingProductIdError, SkuConflictError } from "../product-commerce/errors.js";
import type { ProductCommerce, ProductCommerceStore } from "../ports/product-commerce-store.js";
import type { SeedProductSummaryRow } from "./in-memory-product-commerce-store.js";

export interface ProductCommerceStoreHarness {
	store: ProductCommerceStore;
	/** Phase 2 (`listCommerceByIds`): seed the inventory `on_hand` the store's
	 *  intra-service `inStock` join reads — the dialect harness writes the real
	 *  `inventory` table; the fake harness feeds the fake's lookup. */
	seedStock(sku: string, qty: number): Promise<void>;
	/** Admin-UX Increment 2: seed a bare `product_commerce` row (no upsert/
	 *  idempotency-key dance) with an EXACT `createdAt`, for the admin-list
	 *  contract. The fake wraps `InMemoryProductCommerceStore.seedProductRow`;
	 *  the Kysely harness inserts a real row — so fake, sqlite, and pg exercise
	 *  the identical `listProducts` spec (mirrors `OrderStoreHarness.seedOrder`). */
	seedProduct(row: SeedProductSummaryRow): Promise<void>;
}

/** Seed a priced live product via upsert; return its post-seed row (its
 *  `updatedAt` is the compare-and-set watermark a guarded edit passes back). */
function seedEditable(
	h: ProductCommerceStoreHarness,
	id: string,
	overrides: Partial<{ sku: string; priceCents: number; currency: string; title: string }> = {},
): Promise<ProductCommerce> {
	return h.store.upsert(
		{
			productId: productId(id),
			sku: sku(overrides.sku ?? `SKU-${id}`),
			price: money(cents(overrides.priceCents ?? 1000), currency(overrides.currency ?? "USD")),
			title: overrides.title ?? `Product ${id}`,
			productKind: "physical",
		},
		idempotencyKey(`seed-${id}`),
	);
}

/** A summary-row seed with sensible defaults; overridable per admin-list case. */
function productRow(
	overrides: Partial<SeedProductSummaryRow> & { id: string },
): SeedProductSummaryRow {
	return {
		sku: `SKU-${overrides.id}`,
		title: `Product ${overrides.id}`,
		priceCents: 1000,
		currency: "USD",
		productKind: "physical",
		active: true,
		createdAt: "2026-07-10T00:00:00.000Z",
		...overrides,
	};
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
	// A fixed publish-gate watermark for cases whose intent is NOT ordering
	// (the structural already-active/inactive/soft-deleted guards short-circuit
	// before the watermark is consulted, so an equal watermark on an in-order
	// activate→deactivate still applies). Convergence cases below use DISTINCT
	// timestamps.
	const WM = "2026-07-10T00:00:00.000Z";

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

		// -- updateCommerceFields (guarded admin edit, admin-UX Increment 2) -----

		test("updateCommerceFields applies a commerce edit when expectedUpdatedAt matches", async () => {
			const h = await makeStore();
			const pid = productId("prod-edit-1");
			const seeded = await seedEditable(h, "prod-edit-1", { priceCents: 1000 });

			const res = await h.store.updateCommerceFields(
				{ productId: pid, price: money(cents(2599), currency("USD")), title: "Renamed" },
				idempotencyKey("edit-1"),
				seeded.updatedAt.toISOString(),
			);

			expect(res.ok).toBe(true);
			const row = await h.store.getByProductId(pid);
			expect(row?.price).toEqual({ amount: 2599, currency: "USD" });
			expect(row?.title).toBe("Renamed");
			// The last-applied replay key advanced to the edit's key.
			expect(row?.idempotencyKey).toBe("edit-1");
		});

		test("updateCommerceFields preserves untouched fields (partial update); null clears", async () => {
			const h = await makeStore();
			const pid = productId("prod-edit-partial");
			const seeded = await seedEditable(h, "prod-edit-partial", { title: "Keep me" });

			const res = await h.store.updateCommerceFields(
				{ productId: pid, taxClass: "reduced", weightGrams: null },
				idempotencyKey("edit-1"),
				seeded.updatedAt.toISOString(),
			);

			expect(res.ok).toBe(true);
			const row = await h.store.getByProductId(pid);
			expect(row?.title).toBe("Keep me"); // untouched ⇒ preserved.
			expect(row?.taxClass).toBe("reduced");
			expect(row?.weightGrams).toBeNull();
			expect(row?.price).toEqual({ amount: 1000, currency: "USD" }); // untouched.
		});

		test("updateCommerceFields is an idempotent replay under the same key (stale guard never fires)", async () => {
			const h = await makeStore();
			const pid = productId("prod-edit-replay");
			const seeded = await seedEditable(h, "prod-edit-replay");

			const first = await h.store.updateCommerceFields(
				{ productId: pid, title: "Once" },
				idempotencyKey("edit-1"),
				seeded.updatedAt.toISOString(),
			);
			expect(first.ok).toBe(true);

			// A retry with the SAME key but a now-stale expectedUpdatedAt must still
			// dedupe to ok — replay precedence over the CAS (a double-submit).
			const replay = await h.store.updateCommerceFields(
				{ productId: pid, title: "Once" },
				idempotencyKey("edit-1"),
				"2000-01-01T00:00:00.000Z",
			);
			expect(replay).toEqual({ ok: true, product: await h.store.getByProductId(pid) });
		});

		test("updateCommerceFields returns stale (with the current row) when expectedUpdatedAt mismatches", async () => {
			const h = await makeStore();
			const pid = productId("prod-edit-stale");
			await seedEditable(h, "prod-edit-stale");

			const res = await h.store.updateCommerceFields(
				{ productId: pid, title: "loser" },
				idempotencyKey("edit-1"),
				"2000-01-01T00:00:00.000Z", // an admin who loaded an older revision.
			);

			expect(res.ok).toBe(false);
			if (res.ok) throw new Error("unreachable");
			expect(res.reason).toBe("stale");
			if (res.reason !== "stale") throw new Error("unreachable");
			expect(res.current).toEqual(await h.store.getByProductId(pid));
			// The losing write never landed.
			expect((await h.store.getByProductId(pid))?.title).toBe("Product prod-edit-stale");
		});

		test("updateCommerceFields returns not_found for an unknown product_id (never mints a row)", async () => {
			const h = await makeStore();
			const res = await h.store.updateCommerceFields(
				{ productId: productId("nope"), title: "x" },
				idempotencyKey("edit-1"),
				"2026-07-10T00:00:00.000Z",
			);
			expect(res).toEqual({ ok: false, reason: "not_found" });
			expect(await h.store.getByProductId(productId("nope"))).toBeNull();
		});

		test("updateCommerceFields returns not_found for a soft-deleted product", async () => {
			const h = await makeStore();
			const pid = productId("prod-edit-deleted");
			const seeded = await seedEditable(h, "prod-edit-deleted");
			await h.store.softDelete(pid, idempotencyKey("del-1"));

			const res = await h.store.updateCommerceFields(
				{ productId: pid, title: "resurrect?" },
				idempotencyKey("edit-1"),
				seeded.updatedAt.toISOString(),
			);
			expect(res).toEqual({ ok: false, reason: "not_found" });
		});

		test("updateCommerceFields rejects a silent currency switch on an already-priced product", async () => {
			const h = await makeStore();
			const pid = productId("prod-edit-cur");
			const seeded = await seedEditable(h, "prod-edit-cur", { priceCents: 1000, currency: "USD" });

			const res = await h.store.updateCommerceFields(
				{ productId: pid, price: money(cents(1000), currency("EUR")) },
				idempotencyKey("edit-1"),
				seeded.updatedAt.toISOString(),
			);

			expect(res.ok).toBe(false);
			if (res.ok) throw new Error("unreachable");
			expect(res.reason).toBe("currency_mismatch");
			// The stored price/currency is untouched.
			expect((await h.store.getByProductId(pid))?.price).toEqual({ amount: 1000, currency: "USD" });
		});

		test("updateCommerceFields accepts any currency when first pricing an unpriced row", async () => {
			const h = await makeStore();
			const pid = productId("prod-edit-firstprice");
			// A "create then price" row: exists, but no price/currency yet.
			const seeded = await h.store.upsert(
				{ productId: pid, title: "Unpriced" },
				idempotencyKey("seed-fp"),
			);

			const res = await h.store.updateCommerceFields(
				{ productId: pid, price: money(cents(4200), currency("EUR")) },
				idempotencyKey("edit-1"),
				seeded.updatedAt.toISOString(),
			);

			expect(res.ok).toBe(true);
			expect((await h.store.getByProductId(pid))?.price).toEqual({ amount: 4200, currency: "EUR" });
		});

		test("updateCommerceFields surfaces a live-SKU collision as SkuConflictError", async () => {
			const h = await makeStore();
			await seedEditable(h, "prod-A", { sku: "SKU-SHARED" });
			const b = await seedEditable(h, "prod-B", { sku: "SKU-B" });

			await expect(
				h.store.updateCommerceFields(
					{ productId: productId("prod-B"), sku: sku("SKU-SHARED") },
					idempotencyKey("edit-1"),
					b.updatedAt.toISOString(),
				),
			).rejects.toBeInstanceOf(SkuConflictError);
		});

		test("updateCommerceFields never touches the publish gate (active) or the tombstone", async () => {
			const h = await makeStore();
			const pid = productId("prod-edit-active");
			await seedEditable(h, "prod-edit-active");
			await h.store.activate(pid, idempotencyKey("pub-1"), WM);
			const active = await h.store.getByProductId(pid);
			expect(active?.active).toBe(true);

			const res = await h.store.updateCommerceFields(
				{ productId: pid, title: "still active" },
				idempotencyKey("edit-1"),
				active!.updatedAt.toISOString(),
			);
			expect(res.ok).toBe(true);
			const after = await h.store.getByProductId(pid);
			expect(after?.active).toBe(true); // untouched.
			expect(after?.deletedAt).toBeNull();
		});

		// -- activate (the afterPublish→activate follow-up) ---------------------

		test("activate flips a live row to active=true", async () => {
			const h = await makeStore();
			const pid = productId("prod-act-1");
			await h.store.upsert(
				{ productId: pid, sku: sku("SKU-ACT-1"), price: money(cents(500), currency("USD")) },
				idempotencyKey("k1"),
			);
			expect((await h.store.getByProductId(pid))?.active).toBe(false);

			await h.store.activate(pid, idempotencyKey("pub-1"), WM);

			const read = await h.store.getByProductId(pid);
			expect(read?.active).toBe(true);
			// Commercial data is untouched by activation.
			expect(read?.sku).toBe("SKU-ACT-1");
		});

		test("activate on an unknown product_id is a no-op (no row minted)", async () => {
			const h = await makeStore();
			await h.store.activate(productId("does-not-exist"), idempotencyKey("pub-1"), WM);
			expect(await h.store.getByProductId(productId("does-not-exist"))).toBeNull();
		});

		test("activate of a SOFT-DELETED product does NOT resurrect it — the load-bearing invariant", async () => {
			const h = await makeStore();
			const pid = productId("prod-act-2");
			await h.store.upsert(
				{ productId: pid, sku: sku("SKU-ACT-2"), price: money(cents(500), currency("USD")) },
				idempotencyKey("k1"),
			);
			await h.store.softDelete(pid, idempotencyKey("del-1"));

			// A publish arriving after (or racing) a soft-delete must not revive
			// the row — order history / merchant intent integrity.
			await h.store.activate(pid, idempotencyKey("pub-1"), WM);

			const read = await h.store.getByProductId(pid);
			expect(read?.active).toBe(false);
			expect(read?.deletedAt).not.toBeNull();
		});

		test("activate is a stable no-op when replayed or called on an already-active row", async () => {
			const h = await makeStore();
			const pid = productId("prod-act-3");
			await h.store.upsert(
				{ productId: pid, sku: sku("SKU-ACT-3"), price: money(cents(500), currency("USD")) },
				idempotencyKey("k1"),
			);
			await h.store.activate(pid, idempotencyKey("pub-1"), WM);
			const first = await h.store.getByProductId(pid);

			// A later re-publish (a different key) finds the row already active —
			// stable no-op, not a re-stamp.
			await h.store.activate(pid, idempotencyKey("pub-2"), WM);
			const again = await h.store.getByProductId(pid);

			expect(again?.active).toBe(true);
			expect(again?.updatedAt).toEqual(first?.updatedAt);
			expect(again?.idempotencyKey).toBe(first?.idempotencyKey);
		});

		// -- deactivate (the afterUnpublish→deactivate follow-up) ---------------

		test("deactivate flips an active row back to active=false", async () => {
			const h = await makeStore();
			const pid = productId("prod-deact-1");
			await h.store.upsert(
				{ productId: pid, sku: sku("SKU-DEACT-1"), price: money(cents(500), currency("USD")) },
				idempotencyKey("k1"),
			);
			await h.store.activate(pid, idempotencyKey("pub-1"), WM);
			expect((await h.store.getByProductId(pid))?.active).toBe(true);

			await h.store.deactivate(pid, idempotencyKey("unpub-1"), WM);

			const read = await h.store.getByProductId(pid);
			expect(read?.active).toBe(false);
			// Deactivation flips the publish gate only — it is NOT a soft delete.
			expect(read?.deletedAt).toBeNull();
			// Commercial data is untouched by deactivation.
			expect(read?.sku).toBe("SKU-DEACT-1");
		});

		test("deactivate on an unknown product_id is a no-op (no row minted)", async () => {
			const h = await makeStore();
			await h.store.deactivate(productId("does-not-exist"), idempotencyKey("unpub-1"), WM);
			expect(await h.store.getByProductId(productId("does-not-exist"))).toBeNull();
		});

		test("deactivate of a SOFT-DELETED product leaves it soft-deleted (does NOT resurrect it)", async () => {
			const h = await makeStore();
			const pid = productId("prod-deact-2");
			await h.store.upsert(
				{ productId: pid, sku: sku("SKU-DEACT-2"), price: money(cents(500), currency("USD")) },
				idempotencyKey("k1"),
			);
			await h.store.softDelete(pid, idempotencyKey("del-1"));
			const deleted = await h.store.getByProductId(pid);

			// An unpublish arriving after (or racing) a soft-delete must not touch
			// the tombstone — the deleted row stays deleted, never resurrected.
			await h.store.deactivate(pid, idempotencyKey("unpub-1"), WM);

			const read = await h.store.getByProductId(pid);
			expect(read?.active).toBe(false);
			expect(read?.deletedAt).not.toBeNull();
			expect(read?.deletedAt).toEqual(deleted?.deletedAt);
			// The soft-delete's key is not overwritten by a no-op deactivate.
			expect(read?.idempotencyKey).toBe(deleted?.idempotencyKey);
		});

		test("deactivate is a stable no-op when replayed or called on an already-inactive row", async () => {
			const h = await makeStore();
			const pid = productId("prod-deact-3");
			await h.store.upsert(
				{ productId: pid, sku: sku("SKU-DEACT-3"), price: money(cents(500), currency("USD")) },
				idempotencyKey("k1"),
			);
			// Never activated — already inactive: deactivate is a stable no-op.
			const first = await h.store.getByProductId(pid);
			await h.store.deactivate(pid, idempotencyKey("unpub-1"), WM);
			const afterFirst = await h.store.getByProductId(pid);
			expect(afterFirst?.active).toBe(false);
			expect(afterFirst?.updatedAt).toEqual(first?.updatedAt);
			expect(afterFirst?.idempotencyKey).toBe(first?.idempotencyKey);

			// Activate, deactivate once, then replay the deactivate with a fresh
			// key — the row is already inactive, so the replay is a stable no-op.
			await h.store.activate(pid, idempotencyKey("pub-1"), WM);
			await h.store.deactivate(pid, idempotencyKey("unpub-1"), WM);
			const settled = await h.store.getByProductId(pid);
			await h.store.deactivate(pid, idempotencyKey("unpub-2"), WM);
			const replayed = await h.store.getByProductId(pid);

			expect(replayed?.active).toBe(false);
			expect(replayed?.updatedAt).toEqual(settled?.updatedAt);
			expect(replayed?.idempotencyKey).toBe(settled?.idempotencyKey);
		});

		// -- publish-gate convergence under OUT-OF-ORDER delivery ---------------
		// activate/deactivate are OPPOSING transitions on the same `active`
		// flag, delivered by independent fire-and-forget hook POSTs. Under hook
		// reordering / a rapid publish→unpublish toggle, a stale POST can land
		// after a newer one. The gate watermark (`contentUpdatedAt`, monotonic
		// because EmDash's publish()/unpublish() both bump content.updatedAt)
		// makes the stale POST a no-op so the row converges to the newest
		// lifecycle event — the same guarantee `upsert` already gives.

		const T1 = "2026-07-11T01:00:00.000Z"; // older lifecycle event
		const T2 = "2026-07-11T02:00:00.000Z"; // newer lifecycle event
		const T3 = "2026-07-11T03:00:00.000Z"; // newest lifecycle event

		test("out-of-order: deactivate@T2 (newer) then a STALE activate@T1 (older) — the row stays active=false, purchasability is NOT re-latched", async () => {
			const h = await makeStore();
			const pid = productId("prod-conv-1");
			await h.store.upsert(
				{ productId: pid, sku: sku("SKU-CONV-1"), price: money(cents(500), currency("USD")) },
				idempotencyKey("k1"),
			);
			// The product was published then unpublished; the unpublish (newer
			// watermark) is applied first…
			await h.store.activate(pid, idempotencyKey("pub-early"), T1);
			await h.store.deactivate(pid, idempotencyKey("unpub-2"), T2);
			expect((await h.store.getByProductId(pid))?.active).toBe(false);

			// …then a DELAYED, re-ordered activate carrying the OLDER publish
			// watermark arrives. It must NOT re-activate the row.
			await h.store.activate(pid, idempotencyKey("pub-1-late"), T1);

			const read = await h.store.getByProductId(pid);
			expect(read?.active).toBe(false);
			// And a genuinely newer publish (T3 > T2) still wins — proof the gate
			// watermark advanced to T2, not that the flag is stuck.
			await h.store.activate(pid, idempotencyKey("pub-3"), T3);
			expect((await h.store.getByProductId(pid))?.active).toBe(true);
		});

		test("out-of-order: activate@T2 (newer) then a STALE deactivate@T1 (older) — the row stays active=true", async () => {
			const h = await makeStore();
			const pid = productId("prod-conv-2");
			await h.store.upsert(
				{ productId: pid, sku: sku("SKU-CONV-2"), price: money(cents(500), currency("USD")) },
				idempotencyKey("k1"),
			);
			// A prior unpublish (older) then the current publish (newer) applied
			// in order…
			await h.store.deactivate(pid, idempotencyKey("unpub-early"), T1);
			await h.store.activate(pid, idempotencyKey("pub-2"), T2);
			expect((await h.store.getByProductId(pid))?.active).toBe(true);

			// …then a DELAYED, re-ordered deactivate carrying the OLDER unpublish
			// watermark arrives. It must NOT deactivate the row.
			await h.store.deactivate(pid, idempotencyKey("unpub-1-late"), T1);

			const read = await h.store.getByProductId(pid);
			expect(read?.active).toBe(true);
			// A genuinely newer unpublish (T3 > T2) still wins.
			await h.store.deactivate(pid, idempotencyKey("unpub-3"), T3);
			expect((await h.store.getByProductId(pid))?.active).toBe(false);
		});

		test("in-order publish→unpublish ends non-purchasable: activate@T1 then deactivate@T2 leaves active=false", async () => {
			const h = await makeStore();
			const pid = productId("prod-conv-3");
			await h.store.upsert(
				{ productId: pid, sku: sku("SKU-CONV-3"), price: money(cents(500), currency("USD")) },
				idempotencyKey("k1"),
			);
			await h.store.activate(pid, idempotencyKey("pub-1"), T1);
			expect((await h.store.getByProductId(pid))?.active).toBe(true);
			await h.store.deactivate(pid, idempotencyKey("unpub-2"), T2);

			const read = await h.store.getByProductId(pid);
			// publish→unpublish end state is non-purchasable (the flag the join
			// gates on is false), and the row is NOT soft-deleted.
			expect(read?.active).toBe(false);
			expect(read?.deletedAt).toBeNull();
		});

		test("a stale activate does NOT resurrect a soft-deleted tombstone even with a newer watermark than the delete", async () => {
			const h = await makeStore();
			const pid = productId("prod-conv-4");
			await h.store.upsert(
				{ productId: pid, sku: sku("SKU-CONV-4"), price: money(cents(500), currency("USD")) },
				idempotencyKey("k1"),
			);
			await h.store.softDelete(pid, idempotencyKey("del-1"));
			const deleted = await h.store.getByProductId(pid);

			// The soft-delete guard is checked BEFORE the watermark — a newer
			// watermark can never overrule the tombstone.
			await h.store.activate(pid, idempotencyKey("pub-late"), T3);

			const read = await h.store.getByProductId(pid);
			expect(read?.active).toBe(false);
			expect(read?.deletedAt).toEqual(deleted?.deletedAt);
			expect(read?.idempotencyKey).toBe(deleted?.idempotencyKey);
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
				active: false, // afterPublish deferred — unpublished until it lands
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

		test("listCommerceByIds returns inactive rows FLAGGED active:false and published rows active:true — the store reports state; purchasability is gated at the join", async () => {
			const h = await makeStore();
			const unpublished = productId("prod-b10");
			const published = productId("prod-b10b");
			await h.store.upsert(
				{ productId: unpublished, sku: sku("SKU-B10"), price: money(cents(100), currency("USD")) },
				idempotencyKey("k1"),
			);
			await h.store.upsert(
				{ productId: published, sku: sku("SKU-B10B"), price: money(cents(100), currency("USD")) },
				idempotencyKey("k2"),
			);
			// The afterPublish→activate follow-up, exercised via the real port
			// method (not a test stand-in): joinProduct gates purchasability on
			// this flag (plan §4.2: "purchasable: false iff commerce === null (or
			// explicitly inactive)").
			await h.store.activate(published, idempotencyKey("pub-1"), WM);

			const views = await h.store.listCommerceByIds([unpublished, published]);

			// Both rows LIST (content visibility ≠ purchasability, §4.5) — the
			// flag is what the join gates on.
			expect(views).toHaveLength(2);
			const byId = new Map(views.map((v) => [v.productId as string, v.active]));
			expect(byId.get("prod-b10")).toBe(false);
			expect(byId.get("prod-b10b")).toBe(true);
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

		// -- Bulk snapshot read: getManyByProductId (the checkout N+1 kill) ------
		// The batch companion to getByProductId. Unlike listCommerceByIds it is
		// the RAW row read (full ProductCommerce, no deleted_at/sku/price guards),
		// so its per-id value must deep-equal getByProductId's for every field —
		// branded price (Cents + currency), title, taxClass, productKind, all of
		// it. Missing ids are absent from the Map; duplicates collapse; no order.

		test("getManyByProductId with an empty id list returns an empty Map", async () => {
			const h = await makeStore();
			const map = await h.store.getManyByProductId([]);
			expect(map.size).toBe(0);
		});

		test("getManyByProductId with a single present id returns a size-1 Map whose value deep-equals getByProductId", async () => {
			const h = await makeStore();
			const pid = productId("prod-gm-1");
			await h.store.upsert(
				{
					productId: pid,
					sku: sku("SKU-GM-1"),
					price: money(cents(1999), currency("USD")),
					title: "Widget",
					taxClass: "standard",
					productKind: "physical",
				},
				idempotencyKey("k1"),
			);

			const map = await h.store.getManyByProductId([pid]);
			expect(map.size).toBe(1);
			// The batch value must be byte-for-byte the single read (review-
			// strengthened: catches any dropped/drifted field in the batch path).
			expect(map.get(pid)).toEqual(await h.store.getByProductId(pid));
		});

		test("getManyByProductId returns, FOR EACH id, a value deep-equal to getByProductId (full ProductCommerce, no field drift)", async () => {
			const h = await makeStore();
			const p1 = productId("prod-gm-2a");
			const p2 = productId("prod-gm-2b");
			const p3 = productId("prod-gm-2c");
			await h.store.upsert(
				{
					productId: p1,
					sku: sku("SKU-GM-2A"),
					price: money(cents(500), currency("USD")),
					title: "A",
					taxClass: "standard",
					productKind: "physical",
				},
				idempotencyKey("k1"),
			);
			await h.store.upsert(
				{
					productId: p2,
					sku: sku("SKU-GM-2B"),
					price: money(cents(750), currency("EUR")),
					title: "B",
					taxClass: "reduced",
					productKind: "digital",
				},
				idempotencyKey("k2"),
			);
			await h.store.upsert(
				{
					productId: p3,
					sku: sku("SKU-GM-2C"),
					price: money(cents(1234), currency("GBP")),
					title: "C",
					productKind: "physical",
				},
				idempotencyKey("k3"),
			);

			const map = await h.store.getManyByProductId([p1, p2, p3]);
			expect(map.size).toBe(3);
			// Per-id deep-equality against the single read is the spec: branded
			// price (Cents + currency), title, taxClass, productKind, every field.
			for (const pid of [p1, p2, p3]) {
				expect(map.get(pid)).toEqual(await h.store.getByProductId(pid));
			}
		});

		test("getManyByProductId omits MISSING ids (absent, not null) and still returns the present ones — no throw", async () => {
			const h = await makeStore();
			const present = productId("prod-gm-3");
			const missing = productId("prod-gm-3-missing");
			await h.store.upsert(
				{ productId: present, sku: sku("SKU-GM-3"), price: money(cents(100), currency("USD")) },
				idempotencyKey("k1"),
			);

			const map = await h.store.getManyByProductId([present, missing]);
			// A miss is ABSENT from the Map — never a null entry (mirrors
			// getByProductId returning null for a single miss).
			expect(map.has(missing)).toBe(false);
			expect(map.get(missing)).toBeUndefined();
			expect(map.get(present)).toEqual(await h.store.getByProductId(present));
		});

		test("getManyByProductId collapses duplicate input ids to one entry", async () => {
			const h = await makeStore();
			const pid = productId("prod-gm-4");
			await h.store.upsert(
				{ productId: pid, sku: sku("SKU-GM-4"), price: money(cents(100), currency("USD")) },
				idempotencyKey("k1"),
			);

			const map = await h.store.getManyByProductId([pid, pid, pid]);
			expect(map.size).toBe(1);
			expect(map.get(pid)).toEqual(await h.store.getByProductId(pid));
		});

		test("getManyByProductId is a RAW read: soft-deleted and unpriced rows are STILL returned (it must NOT copy listCommerceByIds's guards)", async () => {
			const h = await makeStore();
			const deleted = productId("prod-gm-5-del");
			const unpriced = productId("prod-gm-5-unpriced");
			await h.store.upsert(
				{ productId: deleted, sku: sku("SKU-GM-5"), price: money(cents(100), currency("USD")) },
				idempotencyKey("k1"),
			);
			await h.store.softDelete(deleted, idempotencyKey("del-1"));
			// "Create, then price" not finished: a bare row with no price yet.
			await h.store.upsert({ productId: unpriced }, idempotencyKey("k2"));

			const map = await h.store.getManyByProductId([deleted, unpriced]);
			// A soft-deleted row is present with deletedAt !== null (mirrors
			// getByProductId; the checkout caller decides PRODUCT_NOT_PRICED, not
			// the store).
			const del = map.get(deleted);
			expect(del).toEqual(await h.store.getByProductId(deleted));
			expect(del?.deletedAt).not.toBeNull();
			// An unpriced row is returned too — the store does NOT decide
			// sellability.
			const un = map.get(unpriced);
			expect(un).toEqual(await h.store.getByProductId(unpriced));
			expect(un?.price).toBeNull();
		});

		// -- Admin Products console: view-only keyset list (admin-UX Increment 2) --

		test("listProducts on an empty store returns no rows and a null cursor", async () => {
			const h = await makeStore();
			const res = await h.store.listProducts({}, { limit: 25 });
			expect(res.products).toEqual([]);
			expect(res.nextCursor).toBeNull();
		});

		test("listProducts projects the summary fields (money as Money, nullable sku/title/price preserved)", async () => {
			const h = await makeStore();
			await h.seedProduct(
				productRow({
					id: "prod-proj",
					sku: "SKU-PROJ",
					title: "Projected Widget",
					priceCents: 4200,
					currency: "EUR",
					productKind: "digital",
					active: true,
					createdAt: "2026-07-10T01:00:00.000Z",
				}),
			);
			const { products } = await h.store.listProducts({}, { limit: 25 });
			expect(products).toHaveLength(1);
			const p = products[0]!;
			expect(p.productId).toBe("prod-proj");
			expect(p.sku).toBe("SKU-PROJ");
			expect(p.title).toBe("Projected Widget");
			expect(p.price).toEqual({ amount: 4200, currency: "EUR" });
			expect(p.productKind).toBe("digital");
			expect(p.active).toBe(true);
			expect(p.createdAt).toBe("2026-07-10T01:00:00.000Z");
		});

		test("listProducts projects a 'create then price' row (null sku/title/price) without throwing", async () => {
			const h = await makeStore();
			await h.seedProduct({
				id: "prod-unpriced",
				sku: null,
				title: null,
				priceCents: null,
				createdAt: "2026-07-10T01:00:00.000Z",
			});
			const { products } = await h.store.listProducts({}, { limit: 25 });
			expect(products).toHaveLength(1);
			expect(products[0]).toMatchObject({ sku: null, title: null, price: null });
		});

		test("listProducts always excludes soft-deleted rows (no toggle exists yet)", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "prod-live", createdAt: "2026-07-10T01:00:00.000Z" }));
			await h.seedProduct(
				productRow({
					id: "prod-deleted",
					createdAt: "2026-07-10T02:00:00.000Z",
					deletedAt: "2026-07-10T03:00:00.000Z",
				}),
			);
			const { products } = await h.store.listProducts({}, { limit: 25 });
			expect(products.map((p) => p.productId)).toEqual(["prod-live"]);
		});

		test("listProducts filters by active", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "a", active: true }));
			await h.seedProduct(productRow({ id: "b", active: false }));
			await h.seedProduct(productRow({ id: "c", active: true }));
			const { products } = await h.store.listProducts({ active: true }, { limit: 25 });
			expect(products.map((p) => p.productId).toSorted()).toEqual(["a", "c"]);
			const inactive = await h.store.listProducts({ active: false }, { limit: 25 });
			expect(inactive.products.map((p) => p.productId)).toEqual(["b"]);
		});

		test("listProducts filters by productKind", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "phys-1", productKind: "physical" }));
			await h.seedProduct(productRow({ id: "dig-1", productKind: "digital" }));
			await h.seedProduct(productRow({ id: "phys-2", productKind: "physical" }));
			const { products } = await h.store.listProducts({ productKind: "digital" }, { limit: 25 });
			expect(products.map((p) => p.productId)).toEqual(["dig-1"]);
		});

		test("listProducts with no filter orders by created_at DESC, then product_id DESC", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "prod-a", createdAt: "2026-07-10T00:00:02.000Z" }));
			await h.seedProduct(productRow({ id: "prod-b", createdAt: "2026-07-10T00:00:02.000Z" }));
			await h.seedProduct(productRow({ id: "prod-c", createdAt: "2026-07-10T00:00:01.000Z" }));
			const { products } = await h.store.listProducts({}, { limit: 25 });
			// Same created_at ⇒ product_id DESC (prod-b before prod-a); older prod-c last.
			expect(products.map((p) => p.productId)).toEqual(["prod-b", "prod-a", "prod-c"]);
		});

		test("listProducts search matches an EXACT sku, case-insensitively", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "a", sku: "Widget-Blue" }));
			await h.seedProduct(productRow({ id: "b", sku: "Widget-Red" }));
			const { products } = await h.store.listProducts({ search: "widget-blue" }, { limit: 25 });
			expect(products.map((p) => p.productId)).toEqual(["a"]);
			// A substring of a sku must NOT match (exact-lower-equals only, like
			// OrderListFilter's buyer_ref search).
			const partial = await h.store.listProducts({ search: "widget" }, { limit: 25 });
			expect(partial.products.map((p) => p.productId).toSorted()).toEqual([]);
		});

		test("listProducts search matches a title SUBSTRING, case-insensitively (deliberately diverges from the exact sku/order-search semantics)", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "a", title: "Blue Widget Deluxe" }));
			await h.seedProduct(productRow({ id: "b", title: "Red Gadget" }));
			const { products } = await h.store.listProducts({ search: "widget" }, { limit: 25 });
			expect(products.map((p) => p.productId)).toEqual(["a"]);
			// Case-insensitive.
			const upper = await h.store.listProducts({ search: "WIDGET" }, { limit: 25 });
			expect(upper.products.map((p) => p.productId)).toEqual(["a"]);
		});

		test("listProducts search treats LIKE metacharacters in the query LITERALLY, never as a SQL wildcard", async () => {
			const h = await makeStore();
			// `_` is a SQL LIKE single-char wildcard; an unescaped search for "a_b"
			// would ALSO match "AXB" (any character in the `_` position) — a false
			// positive this escaping exists to prevent.
			await h.seedProduct(productRow({ id: "literal-underscore", title: "A_B Widget" }));
			await h.seedProduct(productRow({ id: "wildcard-would-match", title: "AXB Widget" }));
			const underscoreSearch = await h.store.listProducts({ search: "a_b" }, { limit: 25 });
			expect(underscoreSearch.products.map((p) => p.productId)).toEqual(["literal-underscore"]);

			// `%` is the SQL LIKE any-sequence wildcard; a literal search containing
			// one (e.g. a "50% off" title) must match only the literal text.
			await h.seedProduct(productRow({ id: "literal-percent", title: "50% off Widget" }));
			await h.seedProduct(productRow({ id: "no-percent", title: "50X off Widget" }));
			const percentSearch = await h.store.listProducts({ search: "50%" }, { limit: 25 });
			expect(percentSearch.products.map((p) => p.productId)).toEqual(["literal-percent"]);
		});

		test("listProducts search matches EITHER the sku half or the title half (not both required)", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "by-sku", sku: "ZZZ-1", title: "Nothing relevant" }));
			await h.seedProduct(
				productRow({ id: "by-title", sku: "NOPE", title: "Special Findable Item" }),
			);
			const bySku = await h.store.listProducts({ search: "zzz-1" }, { limit: 25 });
			expect(bySku.products.map((p) => p.productId)).toEqual(["by-sku"]);
			const byTitle = await h.store.listProducts({ search: "findable" }, { limit: 25 });
			expect(byTitle.products.map((p) => p.productId)).toEqual(["by-title"]);
		});

		test("listProducts search against a null sku/title never throws — it simply cannot match that half", async () => {
			const h = await makeStore();
			await h.seedProduct({
				id: "prod-nulls",
				sku: null,
				title: null,
				priceCents: null,
				createdAt: "2026-07-10T00:00:00.000Z",
			});
			const { products } = await h.store.listProducts({ search: "anything" }, { limit: 25 });
			expect(products).toEqual([]);
		});

		test("listProducts paginates forward with a keyset cursor — no overlap, no gap", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "p1", createdAt: "2026-07-10T00:00:01.000Z" }));
			await h.seedProduct(productRow({ id: "p2", createdAt: "2026-07-10T00:00:02.000Z" }));
			await h.seedProduct(productRow({ id: "p3", createdAt: "2026-07-10T00:00:03.000Z" }));
			// Newest-first: p3, p2, p1.
			const page1 = await h.store.listProducts({}, { limit: 2 });
			expect(page1.products.map((p) => p.productId)).toEqual(["p3", "p2"]);
			expect(page1.nextCursor).not.toBeNull();
			expect(page1.nextCursor?.productId).toBe("p2"); // last returned row
			const page2 = await h.store.listProducts({}, { limit: 2, cursor: page1.nextCursor });
			expect(page2.products.map((p) => p.productId)).toEqual(["p1"]); // remainder
			expect(page2.nextCursor).toBeNull();
			// No overlap, no gap: the two pages concatenate to the full DESC order.
			expect([...page1.products, ...page2.products].map((p) => p.productId)).toEqual([
				"p3",
				"p2",
				"p1",
			]);
		});

		test("listProducts keyset tie-break is stable across a page boundary on identical created_at", async () => {
			const h = await makeStore();
			const at = "2026-07-10T00:00:05.000Z";
			for (const id of ["prod-01", "prod-02", "prod-03", "prod-04"]) {
				await h.seedProduct(productRow({ id, createdAt: at }));
			}
			// All share created_at ⇒ pure product_id DESC.
			const page1 = await h.store.listProducts({}, { limit: 2 });
			expect(page1.products.map((p) => p.productId)).toEqual(["prod-04", "prod-03"]);
			expect(page1.nextCursor).toEqual({ createdAt: at, productId: "prod-03" });
			const page2 = await h.store.listProducts({}, { limit: 2, cursor: page1.nextCursor });
			expect(page2.products.map((p) => p.productId)).toEqual(["prod-02", "prod-01"]);
			expect(page2.nextCursor).toBeNull();
		});

		test("listProducts with rows exactly equal to the limit returns a null cursor (no phantom page)", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "p1", createdAt: "2026-07-10T00:00:01.000Z" }));
			await h.seedProduct(productRow({ id: "p2", createdAt: "2026-07-10T00:00:02.000Z" }));
			const res = await h.store.listProducts({}, { limit: 2 });
			expect(res.products.map((p) => p.productId)).toEqual(["p2", "p1"]);
			expect(res.nextCursor).toBeNull();
		});

		test("listProducts filters compose (active AND productKind AND search)", async () => {
			const h = await makeStore();
			await h.seedProduct(
				productRow({ id: "match", active: true, productKind: "digital", title: "Findable Ebook" }),
			);
			await h.seedProduct(
				productRow({
					id: "wrong-kind",
					active: true,
					productKind: "physical",
					title: "Findable Mug",
				}),
			);
			await h.seedProduct(
				productRow({
					id: "wrong-active",
					active: false,
					productKind: "digital",
					title: "Findable Ebook 2",
				}),
			);
			const { products } = await h.store.listProducts(
				{ active: true, productKind: "digital", search: "findable" },
				{ limit: 25 },
			);
			expect(products.map((p) => p.productId)).toEqual(["match"]);
		});
	});
}
