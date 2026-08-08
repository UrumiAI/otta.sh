import { describe, expect, test } from "vitest";
import { cents, currency, money } from "../money/cents.js";
import { idempotencyKey, productId, sku } from "../money/ids.js";
import {
	InvalidLowStockThresholdError,
	MAX_LOW_STOCK_THRESHOLD,
	MissingProductIdError,
	MissingVariantKeyError,
	SkuConflictError,
	SkuHeldStockError,
	SkuStockConflictError,
} from "../product-commerce/errors.js";
import type {
	ProductCommerce,
	ProductCommerceStore,
	ProductVariant,
	ProductVariantSummary,
} from "../ports/product-commerce-store.js";
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
	/**
	 * Put a LIVE (`held`) reservation on a sku — step 0 of THE SKU-RENAME RULE,
	 * which refuses to rename away from a sku that still has one. The dialect
	 * harness inserts a real `reservations` row; the fake harness feeds the
	 * fake's live-hold lookup.
	 *
	 * Models the reservation row ONLY, not the `on_hand` decrement a real
	 * `reserve` would also make — the rule branches on the hold's EXISTENCE, and
	 * a case that cares about the count seeds it separately with `seedStock`.
	 * Seed the sku's stock first: `reservations.sku` references `inventory.sku`.
	 */
	seedHold(sku: string, qty: number): Promise<void>;
}

/** Seed a priced live product via upsert; return its post-seed row (its
 *  `updatedAt` is the compare-and-set watermark a guarded edit passes back). */
function seedEditable(
	h: ProductCommerceStoreHarness,
	id: string,
	overrides: Partial<{
		sku: string;
		priceCents: number;
		currency: string;
		title: string;
		/** Seed a NON-NULL tax class where a case needs to prove a stored value
		 *  SURVIVED rather than merely "is still null" — see the stale-CAS case. */
		taxClass: string;
	}> = {},
): Promise<ProductCommerce> {
	return h.store.upsert(
		{
			productId: productId(id),
			sku: sku(overrides.sku ?? `SKU-${id}`),
			price: money(cents(overrides.priceCents ?? 1000), currency(overrides.currency ?? "USD")),
			title: overrides.title ?? `Product ${id}`,
			...(overrides.taxClass !== undefined ? { taxClass: overrides.taxClass } : {}),
			productKind: "physical",
		},
		idempotencyKey(`seed-${id}`),
	);
}

/**
 * The on-hand the store PROJECTS for one product id — `ProductSummary.onHand`,
 * sourced from the same `inventory` LEFT JOIN on every adapter, and the only
 * window the harness has onto the stock table. Keeps the two facts the rename
 * rule turns on apart: `null` is "no inventory row at this sku", `0` is "a row
 * that holds nothing".
 */
async function onHandOf(h: ProductCommerceStoreHarness, id: string): Promise<number | null> {
	const { products } = await h.store.listProducts({}, { limit: 100 });
	const row = products.find((p) => p.productId === id);
	if (row === undefined) throw new Error(`onHandOf: no live product listed for ${id}`);
	return row.onHand;
}

/**
 * The same read for a sku NO live product holds — the only ones a rename can
 * legally target. Parks a throwaway product on the sku (a plain create, which
 * changes no sku and therefore carries nothing) and reads its projection, so
 * "the row is retained, holding nothing" (`0`) stays distinguishable from "the
 * row is gone" (`null`). Call it AFTER the assertions about the products a case
 * actually cares about: it mints a row of its own.
 */
async function onHandOfSku(
	h: ProductCommerceStoreHarness,
	probeId: string,
	target: string,
): Promise<number | null> {
	await h.store.upsert(
		{ productId: productId(probeId), sku: sku(target) },
		idempotencyKey(`probe-${probeId}`),
	);
	return onHandOf(h, probeId);
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

		test("upsert HEALS a NULL title: a row created without one gets it from any later upsert that carries it (a null title is why a product is unpurchasable)", async () => {
			const h = await makeStore();
			const pid = productId("prod-title-heal");
			// The shape every CMS-synced row had while the plugin never sent a
			// title: priced, sku'd — and unorderable, because
			// `createOrderFromCart` rejects a null title with PRODUCT_NOT_PRICED.
			const before = await h.store.upsert(
				{ productId: pid, sku: sku("SKU-HEAL"), price: money(cents(1500), currency("USD")) },
				idempotencyKey("k1"),
			);
			expect(before.title).toBeNull();

			// The merchant's next save/publish carries a fresh key and the title.
			const healed = await h.store.upsert(
				{
					productId: pid,
					sku: sku("SKU-HEAL"),
					price: money(cents(1500), currency("USD")),
					title: "Blue Mug",
				},
				idempotencyKey("k2"),
			);

			expect(healed.title).toBe("Blue Mug");
			expect((await h.store.getByProductId(pid))?.title).toBe("Blue Mug");
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
		//
		// NOTE (ADR-0013): these cases deliberately use `taxClass` as their "field
		// that changed". They used `title` until PR 1c, which removed `title` from
		// `UpdateProductCommerceFieldsInput` — the CMS content sync's `upsert` is now
		// its sole writer. `taxClass` is nullable, unencumbered by currency
		// integrity, and owned by this port, so it is the natural stand-in.
		//
		// The values are REAL tax-class ids (`"standard"` / `"reduced"`), never
		// throwaway strings like `"loser"`. `tax_class` is a free-text reference
		// today, but if it ever gains registry validation these nine cases would all
		// break at once; costs nothing to be forward-safe now.

		test("updateCommerceFields applies a commerce edit when expectedUpdatedAt matches", async () => {
			const h = await makeStore();
			const pid = productId("prod-edit-1");
			const seeded = await seedEditable(h, "prod-edit-1", { priceCents: 1000 });

			const res = await h.store.updateCommerceFields(
				{ productId: pid, price: money(cents(2599), currency("USD")), taxClass: "reduced" },
				idempotencyKey("edit-1"),
				seeded.updatedAt.toISOString(),
			);

			expect(res.ok).toBe(true);
			const row = await h.store.getByProductId(pid);
			expect(row?.price).toEqual({ amount: 2599, currency: "USD" });
			expect(row?.taxClass).toBe("reduced");
			// The CMS-owned title is untouched by an admin edit (ADR-0013): this port
			// has no channel to it at all, so the seed's title survives verbatim.
			expect(row?.title).toBe("Product prod-edit-1");
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
				{ productId: pid, taxClass: "reduced" },
				idempotencyKey("edit-1"),
				seeded.updatedAt.toISOString(),
			);
			expect(first.ok).toBe(true);

			// A retry with the SAME key but a now-stale expectedUpdatedAt must still
			// dedupe to ok — replay precedence over the CAS (a double-submit).
			const replay = await h.store.updateCommerceFields(
				{ productId: pid, taxClass: "reduced" },
				idempotencyKey("edit-1"),
				"2000-01-01T00:00:00.000Z",
			);
			expect(replay).toEqual({ ok: true, product: await h.store.getByProductId(pid) });
		});

		test("updateCommerceFields returns stale (with the current row) when expectedUpdatedAt mismatches", async () => {
			const h = await makeStore();
			const pid = productId("prod-edit-stale");
			// Seeded with a REAL stored tax class so the closing assertion proves the
			// prior value SURVIVED, not merely that a null stayed null — the same
			// strength as the HTTP twin, which asserts `sku` still equals a real value.
			await seedEditable(h, "prod-edit-stale", { taxClass: "standard" });

			const res = await h.store.updateCommerceFields(
				{ productId: pid, taxClass: "reduced" },
				idempotencyKey("edit-1"),
				"2000-01-01T00:00:00.000Z", // an admin who loaded an older revision.
			);

			expect(res.ok).toBe(false);
			if (res.ok) throw new Error("unreachable");
			expect(res.reason).toBe("stale");
			if (res.reason !== "stale") throw new Error("unreachable");
			expect(res.current).toEqual(await h.store.getByProductId(pid));
			// The losing write never landed — the seeded value is still there.
			expect((await h.store.getByProductId(pid))?.taxClass).toBe("standard");
		});

		test("updateCommerceFields returns not_found for an unknown product_id (never mints a row)", async () => {
			const h = await makeStore();
			const res = await h.store.updateCommerceFields(
				{ productId: productId("nope"), taxClass: "reduced" },
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
				{ productId: pid, taxClass: "reduced" },
				idempotencyKey("edit-1"),
				seeded.updatedAt.toISOString(),
			);
			expect(res).toEqual({ ok: false, reason: "not_found" });
		});

		test("updateCommerceFields: a same-key replay AFTER the row was soft-deleted is not_found (not a spurious ok)", async () => {
			// Guard-order pin (port doc: not_found OUTRANKS replay): the edit
			// applies with edit-1, then the row is soft-deleted with the SAME key —
			// so the tombstoned row's stored idempotency_key still EQUALS the
			// replay's key. A replay-first impl would return ok over the tombstone;
			// every adapter must classify the deletion first and report not_found.
			const h = await makeStore();
			const pid = productId("prod-edit-replay-del");
			const seeded = await seedEditable(h, "prod-edit-replay-del");

			const applied = await h.store.updateCommerceFields(
				{ productId: pid, taxClass: "reduced" },
				idempotencyKey("edit-1"),
				seeded.updatedAt.toISOString(),
			);
			expect(applied.ok).toBe(true);

			// The row disappears — soft-deleted under the SAME key, so the stored
			// key still matches the replay below.
			await h.store.softDelete(pid, idempotencyKey("edit-1"));
			expect((await h.store.getByProductId(pid))?.idempotencyKey).toBe("edit-1");

			const replay = await h.store.updateCommerceFields(
				{ productId: pid, taxClass: "reduced" },
				idempotencyKey("edit-1"),
				seeded.updatedAt.toISOString(),
			);
			expect(replay).toEqual({ ok: false, reason: "not_found" });
			// The tombstone is untouched by the replay.
			expect((await h.store.getByProductId(pid))?.deletedAt).not.toBeNull();
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

		// -- THE SKU-RENAME RULE (see the `ProductCommerceStore` port doc) -------
		//
		// `inventory` is keyed by the natural key `sku`, so renaming a product's
		// sku is a stock movement wearing a string edit's clothes. These cases pin
		// both halves of the rule on BOTH writers of the column: the units follow
		// the rename inside its own transaction, or the whole write is refused —
		// they are never left behind under a sku no product owns.
		describe("a sku rename carries its on-hand row, or refuses", () => {
			test("updateCommerceFields: a rename CARRIES the on-hand count onto the new sku", async () => {
				const h = await makeStore();
				const seeded = await seedEditable(h, "prod-carry", { sku: "SKU-OLD" });
				await h.seedStock("SKU-OLD", 40);
				expect(await onHandOf(h, "prod-carry")).toBe(40);

				const res = await h.store.updateCommerceFields(
					{ productId: productId("prod-carry"), sku: sku("SKU-NEW") },
					idempotencyKey("rename-1"),
					seeded.updatedAt.toISOString(),
				);

				expect(res.ok).toBe(true);
				if (!res.ok) throw new Error("unreachable");
				expect(res.product.sku).toBe("SKU-NEW");
				// The 40 units followed the product. Before this rule they stayed
				// under SKU-OLD while the product started again from a fresh zero.
				expect(await onHandOf(h, "prod-carry")).toBe(40);
			});

			test("updateCommerceFields: the source row is RETAINED at zero — a stock row is never deleted", async () => {
				const h = await makeStore();
				const seeded = await seedEditable(h, "prod-retain", { sku: "SKU-FROM" });
				await h.seedStock("SKU-FROM", 12);

				await h.store.updateCommerceFields(
					{ productId: productId("prod-retain"), sku: sku("SKU-TO") },
					idempotencyKey("rename-retain"),
					seeded.updatedAt.toISOString(),
				);

				expect(await onHandOf(h, "prod-retain")).toBe(12);
				// `0`, not `null`: the row survives the rename holding nothing.
				// `reservations.sku` references it, so the history a sold sku leaves
				// behind can be neither deleted nor re-keyed.
				expect(await onHandOfSku(h, "probe-retain", "SKU-FROM")).toBe(0);
			});

			test("updateCommerceFields: renaming ONTO a sku that already has an inventory row refuses, naming both skus, and writes nothing", async () => {
				const h = await makeStore();
				const seeded = await seedEditable(h, "prod-src", { sku: "SKU-SRC" });
				await h.seedStock("SKU-SRC", 5);
				// An inventory row NO live product holds — so the live-sku partial
				// index has nothing to say and the refusal is genuinely the stock
				// row's, not `SkuConflictError` wearing a different name.
				await h.seedStock("SKU-TAKEN", 12);

				await expect(
					h.store.updateCommerceFields(
						{ productId: productId("prod-src"), sku: sku("SKU-TAKEN") },
						idempotencyKey("rename-conflict"),
						seeded.updatedAt.toISOString(),
					),
				).rejects.toMatchObject({
					name: "SkuStockConflictError",
					fromSku: "SKU-SRC",
					toSku: "SKU-TAKEN",
				});

				// ATOMIC: the product row rolled back with the stock. The stored
				// replay key is still the seed's, so the guarded UPDATE left no trace.
				const after = await h.store.getByProductId(productId("prod-src"));
				expect(after?.sku).toBe("SKU-SRC");
				expect(after?.idempotencyKey).toBe("seed-prod-src");
				expect(await onHandOf(h, "prod-src")).toBe(5);
				expect(await onHandOfSku(h, "probe-taken", "SKU-TAKEN")).toBe(12);
			});

			test("updateCommerceFields: the refusal is a typed domain error, catchable by class", async () => {
				const h = await makeStore();
				const seeded = await seedEditable(h, "prod-typed", { sku: "SKU-TYPED" });
				await h.seedStock("SKU-TYPED", 1);
				await h.seedStock("SKU-TYPED-TARGET", 1);

				await expect(
					h.store.updateCommerceFields(
						{ productId: productId("prod-typed"), sku: sku("SKU-TYPED-TARGET") },
						idempotencyKey("rename-typed"),
						seeded.updatedAt.toISOString(),
					),
				).rejects.toBeInstanceOf(SkuStockConflictError);
			});

			test("updateCommerceFields: occupied is occupied — a target row holding ZERO refuses exactly like a stocked one", async () => {
				const h = await makeStore();
				const seeded = await seedEditable(h, "prod-zero", { sku: "SKU-Z-SRC" });
				await h.seedStock("SKU-Z-SRC", 8);
				// A row at 0 is "known sku, out of stock" — a DIFFERENT fact from "no
				// such sku", and it may already carry reservations and order lines.
				await h.seedStock("SKU-Z-TARGET", 0);

				await expect(
					h.store.updateCommerceFields(
						{ productId: productId("prod-zero"), sku: sku("SKU-Z-TARGET") },
						idempotencyKey("rename-zero"),
						seeded.updatedAt.toISOString(),
					),
				).rejects.toMatchObject({ name: "SkuStockConflictError", toSku: "SKU-Z-TARGET" });

				expect(await onHandOf(h, "prod-zero")).toBe(8);
			});

			test("updateCommerceFields: re-supplying the SAME sku is not a rename — the count is untouched and nothing refuses", async () => {
				const h = await makeStore();
				const seeded = await seedEditable(h, "prod-same", { sku: "SKU-SAME" });
				await h.seedStock("SKU-SAME", 9);

				const res = await h.store.updateCommerceFields(
					{ productId: productId("prod-same"), sku: sku("SKU-SAME"), taxClass: "standard" },
					idempotencyKey("rename-same"),
					seeded.updatedAt.toISOString(),
				);

				// The row IS its own target: a naive claim-then-zero would refuse the
				// edit outright, or zero the product's own stock.
				expect(res.ok).toBe(true);
				expect(await onHandOf(h, "prod-same")).toBe(9);
			});

			test("updateCommerceFields: setting the FIRST sku on a row that had none carries nothing", async () => {
				const h = await makeStore();
				const bare = await h.store.upsert(
					{ productId: productId("prod-first") },
					idempotencyKey("seed-first"),
				);
				const res = await h.store.updateCommerceFields(
					{ productId: productId("prod-first"), sku: sku("SKU-FIRST") },
					idempotencyKey("rename-first"),
					bare.updatedAt.toISOString(),
				);

				expect(res.ok).toBe(true);
				// No source sku ⇒ no rename ⇒ the rule never engages, so the store
				// mints no inventory row here. Creating it stays the caller's
				// always-attempt `seedOnHand` (`updateProductCommerceFields`), which
				// is where the "a product with a sku has an inventory row" invariant
				// lives — this is a plain edit, not a movement.
				expect(await onHandOf(h, "prod-first")).toBeNull();
			});

			test("updateCommerceFields: a rename FROM a sku with no inventory row moves nothing and refuses nothing", async () => {
				const h = await makeStore();
				const seeded = await seedEditable(h, "prod-norow", { sku: "SKU-NOROW" });
				expect(await onHandOf(h, "prod-norow")).toBeNull();

				const res = await h.store.updateCommerceFields(
					{ productId: productId("prod-norow"), sku: sku("SKU-FRESH") },
					idempotencyKey("rename-norow"),
					seeded.updatedAt.toISOString(),
				);

				expect(res.ok).toBe(true);
				expect(await onHandOf(h, "prod-norow")).toBe(0);
			});

			test("updateCommerceFields: an idempotent REPLAY of a rename moves the units exactly once", async () => {
				const h = await makeStore();
				const seeded = await seedEditable(h, "prod-replay", { sku: "SKU-R-FROM" });
				await h.seedStock("SKU-R-FROM", 30);
				const key = idempotencyKey("rename-replay");
				const input = { productId: productId("prod-replay"), sku: sku("SKU-R-TO") };

				const first = await h.store.updateCommerceFields(
					input,
					key,
					seeded.updatedAt.toISOString(),
				);
				expect(first.ok).toBe(true);
				expect(await onHandOf(h, "prod-replay")).toBe(30);

				// The same key against the now-stale watermark: the replay branch,
				// which the port pins AHEAD of the staleness check. A second carry
				// could not stay quiet even if it wanted to — SKU-R-TO now has a row
				// of its own, so re-running the rule would REFUSE this replay instead
				// of returning ok.
				const replay = await h.store.updateCommerceFields(
					input,
					key,
					seeded.updatedAt.toISOString(),
				);

				expect(replay.ok).toBe(true);
				expect(await onHandOf(h, "prod-replay")).toBe(30);
				expect(await onHandOfSku(h, "probe-replay", "SKU-R-FROM")).toBe(0);
			});

			test("updateCommerceFields: a stale or unknown edit naming a new sku moves nothing", async () => {
				const h = await makeStore();
				await seedEditable(h, "prod-guard", { sku: "SKU-G" });
				await h.seedStock("SKU-G", 6);

				const stale = await h.store.updateCommerceFields(
					{ productId: productId("prod-guard"), sku: sku("SKU-G-STALE") },
					idempotencyKey("guard-stale"),
					"1999-01-01T00:00:00.000Z",
				);
				expect(stale).toMatchObject({ ok: false, reason: "stale" });

				const missing = await h.store.updateCommerceFields(
					{ productId: productId("ghost"), sku: sku("SKU-G-GHOST") },
					idempotencyKey("guard-ghost"),
					"1999-01-01T00:00:00.000Z",
				);
				expect(missing).toEqual({ ok: false, reason: "not_found" });

				expect(await onHandOf(h, "prod-guard")).toBe(6);
				// Neither rejected write so much as claimed a row for its target sku.
				expect(await onHandOfSku(h, "probe-stale", "SKU-G-STALE")).toBeNull();
			});

			test("upsert: a sku change carries the on-hand row too — the rule belongs to the column, not to one writer", async () => {
				const h = await makeStore();
				await h.store.upsert(
					{ productId: productId("prod-u"), sku: sku("SKU-U-FROM") },
					idempotencyKey("u-1"),
				);
				await h.seedStock("SKU-U-FROM", 21);

				const renamed = await h.store.upsert(
					{ productId: productId("prod-u"), sku: sku("SKU-U-TO") },
					idempotencyKey("u-2"),
				);

				expect(renamed.sku).toBe("SKU-U-TO");
				expect(await onHandOf(h, "prod-u")).toBe(21);
				expect(await onHandOfSku(h, "probe-u", "SKU-U-FROM")).toBe(0);
			});

			test("upsert: a sku change onto an occupied inventory row refuses, and the upsert applies nothing", async () => {
				const h = await makeStore();
				await h.store.upsert(
					{ productId: productId("prod-ux"), sku: sku("SKU-UX-FROM") },
					idempotencyKey("ux-1"),
				);
				await h.seedStock("SKU-UX-FROM", 4);
				await h.seedStock("SKU-UX-TAKEN", 3);

				await expect(
					h.store.upsert(
						{ productId: productId("prod-ux"), sku: sku("SKU-UX-TAKEN") },
						idempotencyKey("ux-2"),
					),
				).rejects.toMatchObject({
					name: "SkuStockConflictError",
					fromSku: "SKU-UX-FROM",
					toSku: "SKU-UX-TAKEN",
				});

				const after = await h.store.getByProductId(productId("prod-ux"));
				expect(after?.sku).toBe("SKU-UX-FROM");
				expect(after?.idempotencyKey).toBe("ux-1");
				expect(await onHandOf(h, "prod-ux")).toBe(4);
			});

			test("a rename away from a sku with a LIVE hold is refused, naming the sku and the count", async () => {
				const h = await makeStore();
				const seeded = await seedEditable(h, "prod-held", { sku: "SKU-HELD" });
				await h.seedStock("SKU-HELD", 20);
				// `seedHold` writes the reservation row WITHOUT the on_hand decrement a
				// real `reserve` would also make, so the 20 asserted below is the
				// fixture's number rather than stock arithmetic. That is deliberate:
				// the rule branches on a hold EXISTING, and the decrement's own
				// arithmetic belongs to `InventoryStore`'s contract, not this one.
				await h.seedHold("SKU-HELD", 3);

				// The hold's units are already out of on_hand, and the hold itself
				// cannot follow the rename — so the carry has nothing honest to do
				// with them, and the whole write waits.
				await expect(
					h.store.updateCommerceFields(
						{ productId: productId("prod-held"), sku: sku("SKU-HELD-NEW") },
						idempotencyKey("rename-held"),
						seeded.updatedAt.toISOString(),
					),
				).rejects.toMatchObject({ name: "SkuHeldStockError", sku: "SKU-HELD", liveHolds: 1 });

				const after = await h.store.getByProductId(productId("prod-held"));
				expect(after?.sku).toBe("SKU-HELD");
				expect(after?.idempotencyKey).toBe("seed-prod-held");
				expect(await onHandOf(h, "prod-held")).toBe(20);
				// The target sku was never even claimed.
				expect(await onHandOfSku(h, "probe-held", "SKU-HELD-NEW")).toBeNull();
			});

			test("the live-hold refusal is a typed domain error, and applies to upsert too", async () => {
				const h = await makeStore();
				const seeded = await seedEditable(h, "prod-held-typed", { sku: "SKU-HT" });
				await h.seedStock("SKU-HT", 4);
				await h.seedHold("SKU-HT", 1);

				await expect(
					h.store.updateCommerceFields(
						{ productId: productId("prod-held-typed"), sku: sku("SKU-HT-NEW") },
						idempotencyKey("ht-1"),
						seeded.updatedAt.toISOString(),
					),
				).rejects.toBeInstanceOf(SkuHeldStockError);

				// Same rule, other writer — it belongs to the column, not the caller.
				await expect(
					h.store.upsert(
						{ productId: productId("prod-held-typed"), sku: sku("SKU-HT-NEW2") },
						idempotencyKey("ht-2"),
					),
				).rejects.toBeInstanceOf(SkuHeldStockError);
				expect((await h.store.getByProductId(productId("prod-held-typed")))?.sku).toBe("SKU-HT");
			});

			test("when BOTH refusals apply, the live hold wins — guard order is fixed, like every sibling guard on this port", async () => {
				const h = await makeStore();
				const seeded = await seedEditable(h, "prod-both", { sku: "SKU-BOTH" });
				await h.seedStock("SKU-BOTH", 7);
				await h.seedHold("SKU-BOTH", 1);
				// The target is occupied TOO, so both refusals are live at once and
				// only a fixed order can make every adapter answer the same way.
				await h.seedStock("SKU-BOTH-TARGET", 9);

				// Holds first: it is a fact about the sku the operator is renaming
				// AWAY from, so it is the one they can act on without first choosing a
				// different target — and it is the refusal that will clear by itself.
				await expect(
					h.store.updateCommerceFields(
						{ productId: productId("prod-both"), sku: sku("SKU-BOTH-TARGET") },
						idempotencyKey("both-1"),
						seeded.updatedAt.toISOString(),
					),
				).rejects.toBeInstanceOf(SkuHeldStockError);

				expect((await h.store.getByProductId(productId("prod-both")))?.sku).toBe("SKU-BOTH");
				expect(await onHandOf(h, "prod-both")).toBe(7);
			});

			test("a live hold on the sku does NOT block an edit that leaves the sku alone", async () => {
				const h = await makeStore();
				const seeded = await seedEditable(h, "prod-held-other", { sku: "SKU-HO" });
				await h.seedStock("SKU-HO", 5);
				await h.seedHold("SKU-HO", 2);

				// The refusal is the RENAME's, not the sku's: a busy product stays
				// fully editable on every other field, and on its own sku re-supplied.
				const res = await h.store.updateCommerceFields(
					{ productId: productId("prod-held-other"), sku: sku("SKU-HO"), taxClass: "reduced" },
					idempotencyKey("ho-1"),
					seeded.updatedAt.toISOString(),
				);
				expect(res.ok).toBe(true);
				expect(await onHandOf(h, "prod-held-other")).toBe(5);
			});

			test("THE FIRST-SKU ASYMMETRY: a first sku ADOPTS an existing inventory row, where a rename would have refused", async () => {
				const h = await makeStore();
				const bare = await h.store.upsert(
					{ productId: productId("prod-adopt") },
					idempotencyKey("seed-adopt"),
				);
				// Units already parked under the sku — the state a rename refuses.
				await h.seedStock("SKU-ADOPTED", 33);

				const res = await h.store.updateCommerceFields(
					{ productId: productId("prod-adopt"), sku: sku("SKU-ADOPTED") },
					idempotencyKey("adopt-1"),
					bare.updatedAt.toISOString(),
				);

				// Deliberate, and the pre-existing seed/heal semantics rather than a
				// new decision (see THE FIRST-SKU ASYMMETRY on the port): a product
				// re-linked to a sku it used to own gets its stock back this way, and
				// there is no second count to reconcile because it had none. Renames
				// refuse; first assignment adopts.
				expect(res.ok).toBe(true);
				expect(await onHandOf(h, "prod-adopt")).toBe(33);
			});

			test("upsert: a STALE (reordered) sync whose sku was REJECTED carries nothing", async () => {
				const h = await makeStore();
				const pid = productId("prod-reorder-stock");
				await h.store.upsert(
					{ productId: pid, sku: sku("SKU-CURRENT"), contentUpdatedAt: "2026-07-10T02:00:00.000Z" },
					idempotencyKey("sync-newer"),
				);
				await h.seedStock("SKU-CURRENT", 15);

				// The delayed, older delivery applies nothing — so the sku it names
				// was never the row's, and moving stock onto it would mint inventory
				// for a sku no product owns.
				const returned = await h.store.upsert(
					{
						productId: pid,
						sku: sku("SKU-REJECTED"),
						contentUpdatedAt: "2026-07-10T01:00:00.000Z",
					},
					idempotencyKey("sync-older"),
				);

				expect(returned.sku).toBe("SKU-CURRENT");
				expect(await onHandOf(h, "prod-reorder-stock")).toBe(15);
				expect(await onHandOfSku(h, "probe-rejected", "SKU-REJECTED")).toBeNull();
			});
		});

		test("updateCommerceFields never touches the publish gate (active) or the tombstone", async () => {
			const h = await makeStore();
			const pid = productId("prod-edit-active");
			await seedEditable(h, "prod-edit-active");
			await h.store.activate(pid, idempotencyKey("pub-1"), WM);
			const active = await h.store.getByProductId(pid);
			expect(active?.active).toBe(true);

			const res = await h.store.updateCommerceFields(
				{ productId: pid, taxClass: "reduced" },
				idempotencyKey("edit-1"),
				active!.updatedAt.toISOString(),
			);
			expect(res.ok).toBe(true);
			const after = await h.store.getByProductId(pid);
			expect(after?.active).toBe(true); // untouched.
			expect(after?.deletedAt).toBeNull();
		});

		// -- updateCommerceFields: product data-model adds (Increment 2 slice 5) --
		// compare-at, unit cost, inventory policy, and their atomic currency
		// integrity — the new merchant-standard commercial fields.

		test("updateCommerceFields round-trips compare-at, unit cost, and inventory policy (CAS)", async () => {
			const h = await makeStore();
			const pid = productId("prod-adds-1");
			const seeded = await seedEditable(h, "prod-adds-1", { priceCents: 2000, currency: "USD" });

			const res = await h.store.updateCommerceFields(
				{
					productId: pid,
					compareAtPrice: money(cents(3000), currency("USD")),
					unitCost: money(cents(850), currency("USD")),
					inventoryPolicy: "deny",
				},
				idempotencyKey("adds-edit-1"),
				seeded.updatedAt.toISOString(),
			);
			expect(res.ok).toBe(true);
			const row = await h.store.getByProductId(pid);
			expect(row?.compareAtPrice).toEqual({ amount: 3000, currency: "USD" });
			expect(row?.unitCost).toEqual({ amount: 850, currency: "USD" });
			expect(row?.inventoryPolicy).toBe("deny");
			// The pre-existing price is untouched.
			expect(row?.price).toEqual({ amount: 2000, currency: "USD" });
		});

		test("updateCommerceFields replay under the same key is a no-op ok for the adds too", async () => {
			const h = await makeStore();
			const pid = productId("prod-adds-replay");
			const seeded = await seedEditable(h, "prod-adds-replay", {
				priceCents: 2000,
				currency: "USD",
			});
			const first = await h.store.updateCommerceFields(
				{ productId: pid, compareAtPrice: money(cents(3000), currency("USD")) },
				idempotencyKey("adds-replay-key"),
				seeded.updatedAt.toISOString(),
			);
			expect(first.ok).toBe(true);
			// Same key, now-stale watermark ⇒ replay no-op returning the stored row.
			const replay = await h.store.updateCommerceFields(
				{ productId: pid, compareAtPrice: money(cents(9999), currency("USD")) },
				idempotencyKey("adds-replay-key"),
				seeded.updatedAt.toISOString(),
			);
			expect(replay.ok).toBe(true);
			expect((await h.store.getByProductId(pid))?.compareAtPrice).toEqual({
				amount: 3000,
				currency: "USD",
			});
		});

		test("updateCommerceFields clears compare-at / unit cost with an explicit null", async () => {
			const h = await makeStore();
			const pid = productId("prod-adds-clear");
			const seeded = await seedEditable(h, "prod-adds-clear", {
				priceCents: 2000,
				currency: "USD",
			});
			const set = await h.store.updateCommerceFields(
				{
					productId: pid,
					compareAtPrice: money(cents(3000), currency("USD")),
					unitCost: money(cents(850), currency("USD")),
				},
				idempotencyKey("adds-set"),
				seeded.updatedAt.toISOString(),
			);
			expect(set.ok).toBe(true);
			const afterSet = await h.store.getByProductId(pid);
			const cleared = await h.store.updateCommerceFields(
				{ productId: pid, compareAtPrice: null, unitCost: null },
				idempotencyKey("adds-clear"),
				afterSet!.updatedAt.toISOString(),
			);
			expect(cleared.ok).toBe(true);
			const row = await h.store.getByProductId(pid);
			expect(row?.compareAtPrice).toBeNull();
			expect(row?.unitCost).toBeNull();
		});

		test("updateCommerceFields rejects compare-at / cost whose currency differs from the product's price currency", async () => {
			const h = await makeStore();
			const pid = productId("prod-adds-curmix");
			const seeded = await seedEditable(h, "prod-adds-curmix", {
				priceCents: 2000,
				currency: "USD",
			});
			const res = await h.store.updateCommerceFields(
				{ productId: pid, compareAtPrice: money(cents(3000), currency("EUR")) },
				idempotencyKey("adds-curmix"),
				seeded.updatedAt.toISOString(),
			);
			expect(res.ok).toBe(false);
			if (res.ok) throw new Error("unreachable");
			expect(res.reason).toBe("currency_mismatch");
			// Nothing was written.
			expect((await h.store.getByProductId(pid))?.compareAtPrice).toBeNull();
		});

		test("updateCommerceFields rejects compare-at / cost on a product with no price yet (nothing to match)", async () => {
			const h = await makeStore();
			const pid = productId("prod-adds-unpriced");
			const seeded = await h.store.upsert(
				{ productId: pid, title: "Unpriced" },
				idempotencyKey("seed-adds-unpriced"),
			);
			const res = await h.store.updateCommerceFields(
				{ productId: pid, compareAtPrice: money(cents(3000), currency("USD")) },
				idempotencyKey("adds-unpriced"),
				seeded.updatedAt.toISOString(),
			);
			expect(res.ok).toBe(false);
			if (res.ok) throw new Error("unreachable");
			expect(res.reason).toBe("currency_mismatch");
		});

		test("updateCommerceFields: compare-at MATCHING + unit cost MISMATCHING in one edit is currency_mismatch — nothing written (both fields guarded independently)", async () => {
			// PR #70 review (both reviewers): the Kysely adapter originally guarded
			// only ONE of compareAtPrice/unitCost (an either/or pick), so this exact
			// split — one field matching the stored currency, the other not — wrote a
			// genuinely mixed-currency row. Locked across fake/sqlite/pg.
			const h = await makeStore();
			const pid = productId("prod-adds-split");
			const seeded = await seedEditable(h, "prod-adds-split", {
				priceCents: 2000,
				currency: "USD",
			});
			const res = await h.store.updateCommerceFields(
				{
					productId: pid,
					compareAtPrice: money(cents(3000), currency("USD")), // matches stored
					unitCost: money(cents(850), currency("EUR")), // does NOT
				},
				idempotencyKey("adds-split"),
				seeded.updatedAt.toISOString(),
			);
			expect(res.ok).toBe(false);
			if (res.ok) throw new Error("unreachable");
			expect(res.reason).toBe("currency_mismatch");
			// ATOMIC: neither field landed — the matching compare-at must not be
			// applied while the mismatching cost is rejected.
			const row = await h.store.getByProductId(pid);
			expect(row?.compareAtPrice).toBeNull();
			expect(row?.unitCost).toBeNull();
		});

		test("updateCommerceFields rejects a unit-cost-ALONE currency mismatch against the stored price currency", async () => {
			const h = await makeStore();
			const pid = productId("prod-adds-costmix");
			const seeded = await seedEditable(h, "prod-adds-costmix", {
				priceCents: 2000,
				currency: "USD",
			});
			const res = await h.store.updateCommerceFields(
				{ productId: pid, unitCost: money(cents(850), currency("EUR")) },
				idempotencyKey("adds-costmix"),
				seeded.updatedAt.toISOString(),
			);
			expect(res.ok).toBe(false);
			if (res.ok) throw new Error("unreachable");
			expect(res.reason).toBe("currency_mismatch");
			expect((await h.store.getByProductId(pid))?.unitCost).toBeNull();
		});

		test("updateCommerceFields rejects unit cost ALONE on a product with no price yet (nothing to match)", async () => {
			const h = await makeStore();
			const pid = productId("prod-adds-cost-unpriced");
			const seeded = await h.store.upsert(
				{ productId: pid, title: "Unpriced" },
				idempotencyKey("seed-adds-cost-unpriced"),
			);
			const res = await h.store.updateCommerceFields(
				{ productId: pid, unitCost: money(cents(850), currency("USD")) },
				idempotencyKey("adds-cost-unpriced"),
				seeded.updatedAt.toISOString(),
			);
			expect(res.ok).toBe(false);
			if (res.ok) throw new Error("unreachable");
			expect(res.reason).toBe("currency_mismatch");
		});

		test("updateCommerceFields accepts first-pricing + compare-at + cost in one edit when the currencies agree", async () => {
			const h = await makeStore();
			const pid = productId("prod-adds-firstprice");
			const seeded = await h.store.upsert(
				{ productId: pid, title: "Unpriced" },
				idempotencyKey("seed-adds-fp"),
			);
			const res = await h.store.updateCommerceFields(
				{
					productId: pid,
					price: money(cents(2000), currency("EUR")),
					compareAtPrice: money(cents(3000), currency("EUR")),
					unitCost: money(cents(800), currency("EUR")),
				},
				idempotencyKey("adds-fp"),
				seeded.updatedAt.toISOString(),
			);
			expect(res.ok).toBe(true);
			const row = await h.store.getByProductId(pid);
			expect(row?.price).toEqual({ amount: 2000, currency: "EUR" });
			expect(row?.compareAtPrice).toEqual({ amount: 3000, currency: "EUR" });
			expect(row?.unitCost).toEqual({ amount: 800, currency: "EUR" });
		});

		test("updateCommerceFields allows compare-at ABOVE, equal to, or below price (never rejected)", async () => {
			const h = await makeStore();
			const pid = productId("prod-adds-cmp");
			const seeded = await seedEditable(h, "prod-adds-cmp", { priceCents: 2000, currency: "USD" });
			// compare-at BELOW price (unusual but allowed — a price rise scenario).
			const res = await h.store.updateCommerceFields(
				{ productId: pid, compareAtPrice: money(cents(1500), currency("USD")) },
				idempotencyKey("adds-cmp-below"),
				seeded.updatedAt.toISOString(),
			);
			expect(res.ok).toBe(true);
			expect((await h.store.getByProductId(pid))?.compareAtPrice).toEqual({
				amount: 1500,
				currency: "USD",
			});
		});

		test("countByTaxClass counts LIVE referencing products only (soft-deleted excluded)", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "tc-a", createdAt: "2026-07-10T00:00:00.000Z" }));
			await h.seedProduct(productRow({ id: "tc-b", createdAt: "2026-07-10T00:01:00.000Z" }));
			// Point the two live rows at "reduced" via a guarded edit.
			for (const id of ["tc-a", "tc-b"]) {
				const cur = await h.store.getByProductId(productId(id));
				await h.store.updateCommerceFields(
					{ productId: productId(id), taxClass: "reduced" },
					idempotencyKey(`tc-edit-${id}`),
					cur!.updatedAt.toISOString(),
				);
			}
			// A soft-deleted row referencing the class does NOT count.
			await h.seedProduct(productRow({ id: "tc-deleted", createdAt: "2026-07-10T00:02:00.000Z" }));
			const delCur = await h.store.getByProductId(productId("tc-deleted"));
			await h.store.updateCommerceFields(
				{ productId: productId("tc-deleted"), taxClass: "reduced" },
				idempotencyKey("tc-edit-del"),
				delCur!.updatedAt.toISOString(),
			);
			await h.store.softDelete(productId("tc-deleted"), idempotencyKey("tc-del"));

			expect(await h.store.countByTaxClass("reduced")).toBe(2);
			expect(await h.store.countByTaxClass("standard")).toBe(0);
		});

		test("a soft-deleted row is ALWAYS inactive (softDelete forces active=false)", async () => {
			// Fast-follow pin (Increment 2 slice 5): the tombstone/publish-gate
			// invariant — a soft delete can never leave a row both deleted AND active.
			const h = await makeStore();
			const pid = productId("prod-del-inactive");
			await seedEditable(h, "prod-del-inactive");
			await h.store.activate(pid, idempotencyKey("pub-1"), WM);
			expect((await h.store.getByProductId(pid))?.active).toBe(true);

			await h.store.softDelete(pid, idempotencyKey("del-1"));
			const row = await h.store.getByProductId(pid);
			expect(row?.deletedAt).not.toBeNull();
			expect(row?.active).toBe(false);
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

		// -- ONE HOME PER FIELD (#93 / F4), pinned where it actually lives -------
		// This case REPLACES the long-standing `KNOWN GAP (F4)` case, which
		// asserted the bug: a console reprice to 5000 reverting to the CMS
		// widget's 9900 on the next publish. The CMS no longer stores commercial
		// data (PR 1b), so the sync's upsert body is a title and a watermark, and
		// the reversion is now structurally impossible.
		//
		// It stays in the STORE contract rather than the plugin sandbox for the
		// same reason the gap case did: a stub recorder has no store, so it can
		// observe a request but never a reversion. Both halves are asserted —
		// commercial fields byte-identical (the fix) AND the title updated (the
		// surviving channel, which is the whole point of keeping the column).
		test("#93 (F4) FIXED: a title-only sync upsert with a NEWER watermark leaves every console-edited commercial field byte-identical, and updates the title", async () => {
			const h = await makeStore();
			const pid = productId("prod-f4-no-clobber");
			await h.store.upsert(
				{
					productId: pid,
					title: "Mug",
					contentUpdatedAt: "2026-07-26T10:00:00.000Z",
				},
				idempotencyKey("f4-sync-1"),
			);
			const seeded = await h.store.getByProductId(pid);

			// The merchant sets the whole commercial surface in Pricing &
			// inventory — the ONLY editor of these fields now.
			const edit = await h.store.updateCommerceFields(
				{
					productId: pid,
					sku: sku("SKU-F4"),
					price: money(cents(5000), currency("USD")),
					compareAtPrice: money(cents(8000), currency("USD")),
					unitCost: money(cents(1200), currency("USD")),
					inventoryPolicy: "deny",
					taxClass: "reduced",
					weightGrams: 350,
					lengthMm: 120,
					widthMm: 90,
					heightMm: 95,
					productKind: "physical",
				},
				idempotencyKey("f4-console-edit"),
				seeded!.updatedAt.toISOString(),
			);
			expect(edit.ok).toBe(true);
			const priced = await h.store.getByProductId(pid);

			// Then a CMS save/publish of that product — the exact event that used
			// to revert the reprice. It carries a strictly newer watermark and a
			// renamed title, and nothing else.
			await h.store.upsert(
				{
					productId: pid,
					title: "Cobalt Mug",
					contentUpdatedAt: "2026-07-26T11:00:00.000Z",
				},
				idempotencyKey("f4-sync-2"),
			);

			const after = await h.store.getByProductId(pid);
			// HALF ONE — the fix. Every commercial field survives the sync
			// untouched, including the price that used to revert.
			expect(after?.sku).toBe("SKU-F4");
			expect(after?.price).toEqual({ amount: 5000, currency: "USD" });
			expect(after?.compareAtPrice).toEqual({ amount: 8000, currency: "USD" });
			expect(after?.unitCost).toEqual({ amount: 1200, currency: "USD" });
			expect(after?.inventoryPolicy).toBe("deny");
			expect(after?.taxClass).toBe("reduced");
			expect(after?.weightGrams).toBe(350);
			expect(after?.lengthMm).toBe(120);
			expect(after?.widthMm).toBe(90);
			expect(after?.heightMm).toBe(95);
			expect(after?.productKind).toBe(priced?.productKind);
			// HALF TWO — the surviving channel. The sync IS the title's writer, so
			// the rename must land; the column exists to be an order line's
			// snapshot source without a cross-database read.
			expect(after?.title).toBe("Cobalt Mug");
			// …and the ordering watermark advanced, which is what keeps a delayed
			// out-of-order save from reinstating the old name.
			expect(after?.contentUpdatedAt).toBe("2026-07-26T11:00:00.000Z");
		});

		// §4.4 — the state PR 1b creates. The CMS sync now upserts a row for
		// EVERY products document, so publishing a product nobody ever priced
		// activates a commerce-incomplete row. Benign for purchasability, but a
		// real new state, so it is pinned: the row exists, it is active, and the
		// catalog read still refuses to return it.
		test("§4.4: a title-only row that is ACTIVE is still absent from listCommerceByIds (active ≠ purchasable)", async () => {
			const h = await makeStore();
			const pid = productId("prod-active-unpriced");
			await h.store.upsert(
				{ productId: pid, title: "Unpriced Mug", contentUpdatedAt: WM },
				idempotencyKey("unpriced-sync"),
			);
			await h.store.activate(pid, idempotencyKey("unpriced-pub"), WM);

			const row = await h.store.getByProductId(pid);
			expect(row).not.toBeNull();
			expect(row?.active).toBe(true);
			expect(row?.sku).toBeNull();
			expect(row?.price).toBeNull();

			// The catalog read filters commerce-incomplete rows in SQL, so no
			// commerce data comes back for this product and `joinProduct` reports
			// `purchasable: false`. (The storefront still LISTS it — that grid is
			// built from CMS content — but with no price and no add-to-cart.) The
			// admin's status column says "active (not priced)" for exactly this row.
			expect(await h.store.listCommerceByIds([pid])).toEqual([]);
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
			expect(p.deletedAt).toBeNull();
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
			// No sku ⇒ nothing to join against ⇒ unknown, not "out of stock".
			expect(products[0]!.onHand).toBeNull();
		});

		// -- onHand on the list projection (INC-03) ---------------------------
		// Carried by ONE LEFT JOIN per page, never an N+1. The three states are
		// pinned separately because conflating them is the whole hazard:
		// `null` = no inventory row ("unknown"), `0` = known and out of stock.

		test("listProducts projects onHand from the stock join", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "prod-stocked", sku: "SKU-STOCKED" }));
			await h.seedStock("SKU-STOCKED", 7);
			const { products } = await h.store.listProducts({}, { limit: 25 });
			expect(products[0]!.onHand).toBe(7);
		});

		test("listProducts: a product with NO inventory row projects onHand null — 'unknown', never 0", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "prod-nostock", sku: "SKU-NOSTOCK" }));
			const { products } = await h.store.listProducts({}, { limit: 25 });
			expect(products[0]!.onHand).toBeNull();
			// The assertion that matters: `null` must not have collapsed to 0.
			expect(products[0]!.onHand).not.toBe(0);
		});

		test("listProducts: a sku stocked at ZERO projects onHand 0 — 'out of stock', never null", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "prod-zero", sku: "SKU-ZERO" }));
			await h.seedStock("SKU-ZERO", 0);
			const { products } = await h.store.listProducts({}, { limit: 25 });
			expect(products[0]!.onHand).toBe(0);
			expect(products[0]!.onHand).not.toBeNull();
		});

		test("listProducts carries onHand for EVERY row of a page, mixing all three states", async () => {
			const h = await makeStore();
			await h.seedProduct(
				productRow({ id: "p-a", sku: "SKU-A", createdAt: "2026-07-10T03:00:00.000Z" }),
			);
			await h.seedProduct(
				productRow({ id: "p-b", sku: "SKU-B", createdAt: "2026-07-10T02:00:00.000Z" }),
			);
			await h.seedProduct(
				productRow({
					id: "p-c",
					sku: null,
					title: "No sku",
					createdAt: "2026-07-10T01:00:00.000Z",
				}),
			);
			await h.seedStock("SKU-A", 12);
			await h.seedStock("SKU-B", 0);
			const { products } = await h.store.listProducts({}, { limit: 25 });
			expect(products.map((p) => [p.productId, p.onHand])).toEqual([
				["p-a", 12],
				["p-b", 0],
				["p-c", null],
			]);
		});

		test("listProducts: the stock join never multiplies, drops, or reorders a page", async () => {
			const h = await makeStore();
			// Interleave stocked and unstocked rows so a join that turned INNER
			// would drop rows and one that fanned out would duplicate them.
			for (let i = 0; i < 6; i++) {
				await h.seedProduct(
					productRow({
						id: `p-${i}`,
						sku: `SKU-${i}`,
						createdAt: `2026-07-10T0${String(i)}:00:00.000Z`,
					}),
				);
				if (i % 2 === 0) await h.seedStock(`SKU-${i}`, i);
			}
			const { products, nextCursor } = await h.store.listProducts({}, { limit: 4 });
			expect(products.map((p) => p.productId)).toEqual(["p-5", "p-4", "p-3", "p-2"]);
			expect(products.map((p) => p.onHand)).toEqual([null, 4, null, 2]);
			// The keyset cursor still comes off the LAST returned row, unaffected.
			expect(nextCursor).toEqual({
				createdAt: "2026-07-10T02:00:00.000Z",
				productId: "p-2",
			});
			const page2 = await h.store.listProducts({}, { limit: 4, cursor: nextCursor });
			expect(page2.products.map((p) => p.productId)).toEqual(["p-1", "p-0"]);
			expect(page2.products.map((p) => p.onHand)).toEqual([null, 0]);
		});

		test("listProducts: the archive view carries onHand too (a tombstone's sku may still hold stock)", async () => {
			const h = await makeStore();
			await h.seedProduct(
				productRow({ id: "prod-dead", sku: "SKU-DEAD", deletedAt: "2026-07-11T00:00:00.000Z" }),
			);
			await h.seedStock("SKU-DEAD", 3);
			const { products } = await h.store.listProducts({ deleted: true }, { limit: 25 });
			expect(products).toHaveLength(1);
			expect(products[0]!.onHand).toBe(3);
		});

		test("listProducts excludes soft-deleted rows by DEFAULT (filter.deleted omitted or false)", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "prod-live", createdAt: "2026-07-10T01:00:00.000Z" }));
			await h.seedProduct(
				productRow({
					id: "prod-deleted",
					createdAt: "2026-07-10T02:00:00.000Z",
					deletedAt: "2026-07-10T03:00:00.000Z",
				}),
			);
			const omitted = await h.store.listProducts({}, { limit: 25 });
			expect(omitted.products.map((p) => p.productId)).toEqual(["prod-live"]);
			const explicitFalse = await h.store.listProducts({ deleted: false }, { limit: 25 });
			expect(explicitFalse.products.map((p) => p.productId)).toEqual(["prod-live"]);
		});

		test("listProducts filter.deleted:true is the archive view — ONLY soft-deleted rows list, projecting deletedAt", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "prod-live", createdAt: "2026-07-10T01:00:00.000Z" }));
			await h.seedProduct(
				productRow({
					id: "prod-deleted",
					createdAt: "2026-07-10T02:00:00.000Z",
					deletedAt: "2026-07-10T03:00:00.000Z",
				}),
			);
			const { products } = await h.store.listProducts({ deleted: true }, { limit: 25 });
			expect(products.map((p) => p.productId)).toEqual(["prod-deleted"]);
			expect(products[0]?.deletedAt).toBe("2026-07-10T03:00:00.000Z");
		});

		test("listProducts filter.deleted:true composes with active/productKind/search like every other axis", async () => {
			const h = await makeStore();
			await h.seedProduct(
				productRow({
					id: "deleted-digital",
					productKind: "digital",
					title: "Findable Deleted Ebook",
					createdAt: "2026-07-10T01:00:00.000Z",
					deletedAt: "2026-07-10T02:00:00.000Z",
				}),
			);
			await h.seedProduct(
				productRow({
					id: "deleted-physical",
					productKind: "physical",
					title: "Findable Deleted Mug",
					createdAt: "2026-07-10T01:30:00.000Z",
					deletedAt: "2026-07-10T02:30:00.000Z",
				}),
			);
			const { products } = await h.store.listProducts(
				{ deleted: true, productKind: "digital", search: "findable" },
				{ limit: 25 },
			);
			expect(products.map((p) => p.productId)).toEqual(["deleted-digital"]);
		});

		test("listProducts paginates the archive view (deleted:true) with a keyset cursor — no overlap, no gap", async () => {
			// Fast-follow pin (Increment 2 slice 5): keyset pagination must work
			// under the archive axis exactly as it does for the live default, so a
			// merchant browsing a large trash can page through it deterministically.
			const h = await makeStore();
			for (let i = 1; i <= 3; i++) {
				await h.seedProduct(
					productRow({
						id: `arch-${i}`,
						createdAt: `2026-07-10T0${i}:00:00.000Z`,
						deletedAt: `2026-07-10T0${i}:30:00.000Z`,
					}),
				);
			}
			// Also a live row that must NEVER appear in the archive pages.
			await h.seedProduct(productRow({ id: "arch-live", createdAt: "2026-07-10T09:00:00.000Z" }));

			const page1 = await h.store.listProducts({ deleted: true }, { limit: 2 });
			// created_at DESC ⇒ newest deleted first.
			expect(page1.products.map((p) => p.productId)).toEqual(["arch-3", "arch-2"]);
			expect(page1.nextCursor).not.toBeNull();
			const page2 = await h.store.listProducts(
				{ deleted: true },
				{ limit: 2, cursor: page1.nextCursor },
			);
			expect(page2.products.map((p) => p.productId)).toEqual(["arch-1"]);
			expect(page2.nextCursor).toBeNull();
			// Every row across both pages is a tombstone; the live row never leaks in.
			for (const p of [...page1.products, ...page2.products]) {
				expect(p.deletedAt).not.toBeNull();
			}
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

		// -- lowStockThreshold (the low-stock filter predicate) ----------------
		// The rule behind the admin console's "Low stock only" filter, applied by
		// the store over the whole catalog rather than by a caller trimming a
		// page it already fetched: a row matches iff its sku resolves to a KNOWN
		// on-hand count (an `inventory` row exists)
		// AND that count is <= the threshold. Absent (no inventory row, or no sku
		// at all) is NEVER low stock — "unknown" is a different fact from "known
		// and low" (port doc, `ProductSummary.onHand`). Omitting the field is a
		// no-op, mirroring the plugin's `filterUnavailable` degradation for an
		// unresolved threshold: never filter, never "filter to nothing".

		test("listProducts filter.lowStockThreshold omitted is a no-op — every row lists regardless of stock (the unchanged default)", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "p-low", sku: "SKU-LOW" }));
			await h.seedProduct(productRow({ id: "p-high", sku: "SKU-HIGH" }));
			await h.seedProduct(productRow({ id: "p-none", sku: "SKU-NONE" }));
			await h.seedStock("SKU-LOW", 1);
			await h.seedStock("SKU-HIGH", 100);
			// SKU-NONE is never seeded: onHand stays null (unknown), and the omitted
			// filter still lists it — proof this is a no-op, not "threshold 0".
			const { products } = await h.store.listProducts({}, { limit: 25 });
			expect(products.map((p) => p.productId).toSorted()).toEqual(["p-high", "p-low", "p-none"]);
		});

		test("listProducts filter.lowStockThreshold matches a KNOWN on-hand count at or below the threshold, inclusive", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "p-low", sku: "SKU-LOW" }));
			await h.seedProduct(productRow({ id: "p-boundary", sku: "SKU-BOUNDARY" }));
			await h.seedProduct(productRow({ id: "p-high", sku: "SKU-HIGH" }));
			await h.seedStock("SKU-LOW", 2);
			await h.seedStock("SKU-BOUNDARY", 5); // exactly the threshold: INCLUDED (<=, not <).
			await h.seedStock("SKU-HIGH", 6); // one over the threshold: excluded.
			const { products } = await h.store.listProducts({ lowStockThreshold: 5 }, { limit: 25 });
			expect(products.map((p) => p.productId).toSorted()).toEqual(["p-boundary", "p-low"]);
		});

		test("listProducts filter.lowStockThreshold treats on-hand ZERO as low stock — a known fact, not an unknown one", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "p-zero", sku: "SKU-ZERO" }));
			await h.seedStock("SKU-ZERO", 0);
			const { products } = await h.store.listProducts({ lowStockThreshold: 5 }, { limit: 25 });
			expect(products.map((p) => p.productId)).toEqual(["p-zero"]);
		});

		test("listProducts filter.lowStockThreshold EXCLUDES a product with NO inventory row — unknown is never low stock", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "p-unknown", sku: "SKU-UNKNOWN" }));
			await h.seedProduct(productRow({ id: "p-low", sku: "SKU-LOW" }));
			await h.seedStock("SKU-LOW", 1);
			// SKU-UNKNOWN is never seeded — absent is not zero (port doc).
			const { products } = await h.store.listProducts({ lowStockThreshold: 5 }, { limit: 25 });
			expect(products.map((p) => p.productId)).toEqual(["p-low"]);
		});

		test("listProducts filter.lowStockThreshold EXCLUDES a 'create then price' row with no sku at all", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "p-nosku", sku: null, title: "No sku yet" }));
			await h.seedProduct(productRow({ id: "p-low", sku: "SKU-LOW" }));
			await h.seedStock("SKU-LOW", 1);
			const { products } = await h.store.listProducts({ lowStockThreshold: 5 }, { limit: 25 });
			expect(products.map((p) => p.productId)).toEqual(["p-low"]);
		});

		test("listProducts filter.lowStockThreshold composes with active/productKind/search like every other axis", async () => {
			const h = await makeStore();
			await h.seedProduct(
				productRow({
					id: "match",
					sku: "SKU-MATCH",
					active: true,
					productKind: "digital",
					title: "Findable Ebook",
				}),
			);
			await h.seedStock("SKU-MATCH", 1);
			await h.seedProduct(
				productRow({
					id: "wrong-kind",
					sku: "SKU-WRONG-KIND",
					active: true,
					productKind: "physical",
					title: "Findable Mug",
				}),
			);
			await h.seedStock("SKU-WRONG-KIND", 1);
			await h.seedProduct(
				productRow({
					id: "wrong-stock",
					sku: "SKU-WRONG-STOCK",
					active: true,
					productKind: "digital",
					title: "Findable Plenty",
				}),
			);
			await h.seedStock("SKU-WRONG-STOCK", 999);
			const { products } = await h.store.listProducts(
				{ active: true, productKind: "digital", search: "findable", lowStockThreshold: 5 },
				{ limit: 25 },
			);
			expect(products.map((p) => p.productId)).toEqual(["match"]);
		});

		test("listProducts filter.lowStockThreshold paginates correctly — a filtered set keysets with no overlap and no gap", async () => {
			const h = await makeStore();
			// Five low-stock rows, distinct createdAt for a deterministic order, plus
			// a plentiful row and an unknown-stock row that must NEVER surface on any
			// page of the filtered walk.
			for (let i = 0; i < 5; i++) {
				await h.seedProduct(
					productRow({
						id: `p-low-${i}`,
						sku: `SKU-LOW-${i}`,
						createdAt: `2026-07-10T0${String(i)}:00:00.000Z`,
					}),
				);
				await h.seedStock(`SKU-LOW-${i}`, i);
			}
			await h.seedProduct(
				productRow({ id: "p-high", sku: "SKU-HIGH", createdAt: "2026-07-10T09:00:00.000Z" }),
			);
			await h.seedStock("SKU-HIGH", 999);
			await h.seedProduct(
				productRow({ id: "p-unknown", sku: "SKU-UNKNOWN", createdAt: "2026-07-10T08:00:00.000Z" }),
			);

			// Newest-first: p-low-4, p-low-3, p-low-2, p-low-1, p-low-0 — p-high and
			// p-unknown never appear on any page.
			const page1 = await h.store.listProducts({ lowStockThreshold: 4 }, { limit: 2 });
			expect(page1.products.map((p) => p.productId)).toEqual(["p-low-4", "p-low-3"]);
			expect(page1.nextCursor).not.toBeNull();
			const page2 = await h.store.listProducts(
				{ lowStockThreshold: 4 },
				{ limit: 2, cursor: page1.nextCursor },
			);
			expect(page2.products.map((p) => p.productId)).toEqual(["p-low-2", "p-low-1"]);
			expect(page2.nextCursor).not.toBeNull();
			const page3 = await h.store.listProducts(
				{ lowStockThreshold: 4 },
				{ limit: 2, cursor: page2.nextCursor },
			);
			expect(page3.products.map((p) => p.productId)).toEqual(["p-low-0"]);
			expect(page3.nextCursor).toBeNull();
		});

		test("listProducts filter.lowStockThreshold matching NOTHING returns an empty page with a null cursor (an inventory-never-synced store)", async () => {
			const h = await makeStore();
			// Never seeded via `seedStock` at all — every row is unknown stock, the
			// most realistic way to hit the "total describes the filtered set"
			// boundary this increment exists to guarantee.
			await h.seedProduct(productRow({ id: "p-unsynced-1", sku: "SKU-UNSYNCED-1" }));
			await h.seedProduct(productRow({ id: "p-unsynced-2", sku: "SKU-UNSYNCED-2" }));
			const { products, nextCursor } = await h.store.listProducts(
				{ lowStockThreshold: 0 },
				{ limit: 25 },
			);
			expect(products).toEqual([]);
			expect(nextCursor).toBeNull();
		});

		test("listProducts filter.lowStockThreshold OUTSIDE its non-negative-integer domain throws InvalidLowStockThresholdError, never a silent per-adapter answer", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "p-1", sku: "SKU-1" }));
			await h.seedStock("SKU-1", 3);
			for (const bad of [
				2.5,
				-1,
				-0.5,
				Number.NaN,
				Number.POSITIVE_INFINITY,
				Number.NEGATIVE_INFINITY,
				// ABOVE int4, and it belongs IN this list rather than beside it: the
				// threshold is bound against `inventory.on_hand`, a Postgres
				// `integer`, so an out-of-range value is refused by pg and ACCEPTED
				// by SQLite and the fake. That is the same three-way disagreement
				// every other entry here names, which is why the bound lives in the
				// shared guard rather than at one adapter.
				MAX_LOW_STOCK_THRESHOLD + 1,
				Number.MAX_SAFE_INTEGER,
			]) {
				await expect(
					h.store.listProducts({ lowStockThreshold: bad }, { limit: 25 }),
				).rejects.toBeInstanceOf(InvalidLowStockThresholdError);
			}
		});

		// -- countProducts (INC-23: the exact count the admin list captions with) --

		test("countProducts counts the whole filtered set, independently of any page size", async () => {
			const h = await makeStore();
			for (const id of ["c1", "c2", "c3"]) await h.seedProduct(productRow({ id }));
			// The point of the count: a 2-row page says nothing about the set behind
			// it, and keyset paging carries no running offset to derive one from.
			const page = await h.store.listProducts({}, { limit: 2 });
			expect(page.products).toHaveLength(2);
			expect(page.nextCursor).not.toBeNull();
			expect(await h.store.countProducts({})).toBe(3);
		});

		test("countProducts applies the SAME tombstone default as listProducts, and the archive axis with it", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "live-1" }));
			await h.seedProduct(productRow({ id: "live-2" }));
			await h.seedProduct(productRow({ id: "gone", deletedAt: "2026-07-10T02:00:00.000Z" }));
			// Default: live rows only — a count must never include a tombstone the
			// list it captions will never show.
			expect(await h.store.countProducts({})).toBe(2);
			// Archive view: the mirror image, exactly as `listProducts` flips it.
			expect(await h.store.countProducts({ deleted: true })).toBe(1);
		});

		test("countProducts applies the full listProducts predicate (active AND kind AND search)", async () => {
			const h = await makeStore();
			await h.seedProduct(
				productRow({ id: "match", active: true, productKind: "digital", title: "Findable Ebook" }),
			);
			await h.seedProduct(
				productRow({ id: "wrong-kind", active: true, productKind: "physical", title: "Findable" }),
			);
			await h.seedProduct(
				productRow({
					id: "wrong-active",
					active: false,
					productKind: "digital",
					title: "Findable",
				}),
			);
			expect(
				await h.store.countProducts({ active: true, productKind: "digital", search: "findable" }),
			).toBe(1);
			expect(await h.store.countProducts({})).toBe(3);
		});

		test("countProducts applies the SAME lowStockThreshold predicate as listProducts, inclusive at the boundary", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "p-low", sku: "SKU-LOW" }));
			await h.seedProduct(productRow({ id: "p-boundary", sku: "SKU-BOUNDARY" }));
			await h.seedProduct(productRow({ id: "p-high", sku: "SKU-HIGH" }));
			await h.seedProduct(productRow({ id: "p-unknown", sku: "SKU-UNKNOWN" }));
			await h.seedStock("SKU-LOW", 2);
			await h.seedStock("SKU-BOUNDARY", 5);
			await h.seedStock("SKU-HIGH", 6);
			// SKU-UNKNOWN is never seeded.
			expect(await h.store.countProducts({ lowStockThreshold: 5 })).toBe(2);
			expect(await h.store.countProducts({})).toBe(4);
		});

		test("countProducts filter.lowStockThreshold composes with active/productKind/search like every other axis", async () => {
			const h = await makeStore();
			await h.seedProduct(
				productRow({
					id: "match",
					sku: "SKU-MATCH",
					active: true,
					productKind: "digital",
					title: "Findable Ebook",
				}),
			);
			await h.seedStock("SKU-MATCH", 1);
			await h.seedProduct(
				productRow({
					id: "wrong-stock",
					sku: "SKU-WRONG-STOCK",
					active: true,
					productKind: "digital",
					title: "Findable Plenty",
				}),
			);
			await h.seedStock("SKU-WRONG-STOCK", 999);
			expect(
				await h.store.countProducts({
					active: true,
					productKind: "digital",
					search: "findable",
					lowStockThreshold: 5,
				}),
			).toBe(1);
			expect(await h.store.countProducts({})).toBe(2);
		});

		test("countProducts filter.lowStockThreshold matching NOTHING is 0 — describes the filtered set, not the unfiltered catalog (an inventory-never-synced store)", async () => {
			const h = await makeStore();
			await h.seedProduct(productRow({ id: "p-unsynced-1", sku: "SKU-UNSYNCED-1" }));
			await h.seedProduct(productRow({ id: "p-unsynced-2", sku: "SKU-UNSYNCED-2" }));
			expect(await h.store.countProducts({ lowStockThreshold: 0 })).toBe(0);
			expect(await h.store.countProducts({})).toBe(2);
		});

		test("countProducts filter.lowStockThreshold OUTSIDE its non-negative-integer domain throws InvalidLowStockThresholdError, matching listProducts", async () => {
			const h = await makeStore();
			for (const bad of [
				2.5,
				-1,
				-0.5,
				Number.NaN,
				Number.POSITIVE_INFINITY,
				Number.NEGATIVE_INFINITY,
				// ABOVE int4, and it belongs IN this list rather than beside it: the
				// threshold is bound against `inventory.on_hand`, a Postgres
				// `integer`, so an out-of-range value is refused by pg and ACCEPTED
				// by SQLite and the fake. That is the same three-way disagreement
				// every other entry here names, which is why the bound lives in the
				// shared guard rather than at one adapter.
				MAX_LOW_STOCK_THRESHOLD + 1,
				Number.MAX_SAFE_INTEGER,
			]) {
				await expect(h.store.countProducts({ lowStockThreshold: bad })).rejects.toBeInstanceOf(
					InvalidLowStockThresholdError,
				);
			}
		});

		test("countProducts on an empty store is 0", async () => {
			const h = await makeStore();
			expect(await h.store.countProducts({})).toBe(0);
		});

		// -- Variants: one commerce row per sellable unit ----------------------
		//
		// Stock and price are sku-level facts, so a size that can be bought
		// separately is a ROW. Everything below is ADDITIVE: with no variants
		// declared — the state the entire live catalog is in — not one assertion
		// above changes, which is what the first case in this block pins.

		describe("variants: one commerce row per sellable unit", () => {
			/** The one instant every variant case uses where ordering is not the
			 *  point (the presence watermark; distinct values below where it is). */
			const V_WM = "2026-07-10T00:00:00.000Z";

			/** Declare a variant the way the CMS does — key + display name only,
			 *  never a commercial field — and return the stored row. */
			function declare(
				h: ProductCommerceStoreHarness,
				pid: string,
				key: string,
				title?: string,
			): Promise<ProductVariant> {
				return h.store.upsertVariant(
					{
						productId: productId(pid),
						variantKey: key,
						title: title ?? `Variant ${key}`,
						contentUpdatedAt: V_WM,
					},
					idempotencyKey(`declare-${pid}-${key}`),
				);
			}

			/** One variant's row as the store projects it, by key. Throws rather
			 *  than returning undefined so a case never asserts against a hole. */
			async function variantOf(
				h: ProductCommerceStoreHarness,
				pid: string,
				key: string,
			): Promise<ProductVariantSummary> {
				const rows = await h.store.listVariants(productId(pid));
				const row = rows.find((v) => v.variantKey === key);
				if (row === undefined) throw new Error(`variantOf: no variant ${key} on ${pid}`);
				return row;
			}

			test("INERT: a product that declares no variants lists none, and the product surfaces are untouched", async () => {
				const h = await makeStore();
				await seedEditable(h, "prod-inert", { sku: "SKU-INERT" });
				await h.seedStock("SKU-INERT", 5);

				// The entire live catalog is in this state. Absence, never an error —
				// and never a phantom "default" variant standing in for the product.
				expect(await h.store.listVariants(productId("prod-inert"))).toEqual([]);
				expect(await h.store.listVariants(productId("no-such-product"))).toEqual([]);

				// And the product-level reads answer exactly as they did before this
				// table existed: same row, same projection, same count.
				const { products, nextCursor } = await h.store.listProducts({}, { limit: 25 });
				expect(products).toHaveLength(1);
				expect(products[0]).toMatchObject({
					productId: "prod-inert",
					sku: "SKU-INERT",
					onHand: 5,
				});
				expect(nextCursor).toBeNull();
				expect(await h.store.countProducts({})).toBe(1);
			});

			test("upsertVariant declares a variant: the CMS writes the key and the name, and NOTHING commercial", async () => {
				const h = await makeStore();
				await seedEditable(h, "prod-dec");

				const v = await declare(h, "prod-dec", "large", "Large");

				expect(v.productId).toBe("prod-dec");
				expect(v.variantKey).toBe("large");
				expect(v.title).toBe("Large");
				// Declared, not priced: the sync channel cannot write either field, so
				// a fresh variant is always absent on both — never 0, never "".
				expect(v.sku).toBeNull();
				expect(v.price).toBeNull();
				expect(v.orphanedAt).toBeNull();
				expect(await variantOf(h, "prod-dec", "large")).toMatchObject({
					variantKey: "large",
					title: "Large",
					onHand: null,
				});
			});

			test("upsertVariant rejects an empty variant key and an empty product id before any row is minted", async () => {
				const h = await makeStore();
				await expect(
					h.store.upsertVariant(
						{ productId: productId("prod-bad"), variantKey: "" },
						idempotencyKey("bad-1"),
					),
				).rejects.toBeInstanceOf(MissingVariantKeyError);
				await expect(
					h.store.upsertVariant(
						{ productId: "" as ReturnType<typeof productId>, variantKey: "k" },
						idempotencyKey("bad-2"),
					),
				).rejects.toBeInstanceOf(MissingProductIdError);
				expect(await h.store.listVariants(productId("prod-bad"))).toEqual([]);
			});

			test("upsertVariant lands a variant even when its product row does not exist yet (out-of-order delivery converges)", async () => {
				const h = await makeStore();
				// The repeater's POST can outrun `content:afterSave`'s, exactly as
				// `activate` can. A foreign key would abort here instead of converging.
				const v = await declare(h, "prod-later", "small", "Small");
				expect(v.variantKey).toBe("small");
				expect(await h.store.listVariants(productId("prod-later"))).toHaveLength(1);
			});

			test("upsertVariant replayed under the SAME key is a no-op returning the stored row", async () => {
				const h = await makeStore();
				const first = await h.store.upsertVariant(
					{ productId: productId("prod-rep"), variantKey: "k", title: "First" },
					idempotencyKey("v-rep"),
				);
				const replay = await h.store.upsertVariant(
					{ productId: productId("prod-rep"), variantKey: "k", title: "Second" },
					idempotencyKey("v-rep"),
				);
				expect(replay.title).toBe("First");
				expect(replay.updatedAt).toEqual(first.updatedAt);
			});

			test("upsertVariant is order-aware: a strictly OLDER contentUpdatedAt is a stale no-op; equal or newer applies", async () => {
				const h = await makeStore();
				await h.store.upsertVariant(
					{
						productId: productId("prod-wm"),
						variantKey: "k",
						title: "Newer",
						contentUpdatedAt: "2026-07-10T02:00:00.000Z",
					},
					idempotencyKey("wm-newer"),
				);

				const stale = await h.store.upsertVariant(
					{
						productId: productId("prod-wm"),
						variantKey: "k",
						title: "Delayed older delivery",
						contentUpdatedAt: "2026-07-10T01:00:00.000Z",
					},
					idempotencyKey("wm-older"),
				);
				expect(stale.title).toBe("Newer");

				const applied = await h.store.upsertVariant(
					{
						productId: productId("prod-wm"),
						variantKey: "k",
						title: "Newest",
						contentUpdatedAt: "2026-07-10T03:00:00.000Z",
					},
					idempotencyKey("wm-newest"),
				);
				expect(applied.title).toBe("Newest");
			});

			test("upsertVariant preserves an omitted title and clears an explicit null", async () => {
				const h = await makeStore();
				await declare(h, "prod-t", "k", "Named");

				const preserved = await h.store.upsertVariant(
					{ productId: productId("prod-t"), variantKey: "k" },
					idempotencyKey("t-preserve"),
				);
				expect(preserved.title).toBe("Named");

				const cleared = await h.store.upsertVariant(
					{ productId: productId("prod-t"), variantKey: "k", title: null },
					idempotencyKey("t-clear"),
				);
				expect(cleared.title).toBeNull();
			});

			test("THE KEY IS THE IDENTITY: a different key mints a SECOND variant and leaves the first exactly as it was — never a re-key", async () => {
				const h = await makeStore();
				await declare(h, "prod-key", "sizel", "Large");
				const seeded = await variantOf(h, "prod-key", "sizel");
				await h.store.updateVariantFields(
					{ productId: productId("prod-key"), variantKey: "sizel", sku: sku("TEE-L") },
					idempotencyKey("key-price"),
					seeded.updatedAt.toISOString(),
				);

				// The shape a CMS re-key takes on this side: a new key arrives, the old
				// one is still there holding the sku. Nothing is renamed and nothing is
				// silently moved — which is exactly why the sync must refuse the re-key
				// at save time, where it can still be explained to the operator.
				await declare(h, "prod-key", "sizelarge", "Large");

				const rows = await h.store.listVariants(productId("prod-key"));
				expect(rows.map((v) => v.variantKey)).toEqual(["sizel", "sizelarge"]);
				expect(rows.find((v) => v.variantKey === "sizel")?.sku).toBe("TEE-L");
				expect(rows.find((v) => v.variantKey === "sizelarge")?.sku).toBeNull();
			});

			test("listVariants orders by variant key, ascending and stably", async () => {
				const h = await makeStore();
				await declare(h, "prod-ord", "small");
				await declare(h, "prod-ord", "large");
				await declare(h, "prod-ord", "medium");

				const rows = await h.store.listVariants(productId("prod-ord"));
				expect(rows.map((v) => v.variantKey)).toEqual(["large", "medium", "small"]);
			});

			test("listVariants scopes to its own product", async () => {
				const h = await makeStore();
				await declare(h, "prod-x", "k");
				await declare(h, "prod-y", "k");

				const rows = await h.store.listVariants(productId("prod-x"));
				expect(rows.map((v) => v.productId)).toEqual(["prod-x"]);
			});

			test("listVariants projects onHand in THREE states: unknown (no row / no sku), zero, and a real count", async () => {
				const h = await makeStore();
				await declare(h, "prod-stock", "nosku");
				await declare(h, "prod-stock", "unstocked");
				await declare(h, "prod-stock", "empty");
				await declare(h, "prod-stock", "stocked");
				const rows = await h.store.listVariants(productId("prod-stock"));
				for (const key of ["unstocked", "empty", "stocked"]) {
					const row = rows.find((v) => v.variantKey === key);
					if (row === undefined) throw new Error(`missing ${key}`);
					await h.store.updateVariantFields(
						{
							productId: productId("prod-stock"),
							variantKey: key,
							sku: sku(`SKU-${key.toUpperCase()}`),
						},
						idempotencyKey(`price-${key}`),
						row.updatedAt.toISOString(),
					);
				}
				await h.seedStock("SKU-EMPTY", 0);
				await h.seedStock("SKU-STOCKED", 7);

				// A variant with no inventory row is ABSENT, never 0 — the fact the
				// console renders as an em dash. `0` is a KNOWN sku that is out of
				// stock, and the two may never be folded together.
				expect((await variantOf(h, "prod-stock", "nosku")).onHand).toBeNull();
				expect((await variantOf(h, "prod-stock", "unstocked")).onHand).toBeNull();
				expect((await variantOf(h, "prod-stock", "empty")).onHand).toBe(0);
				expect((await variantOf(h, "prod-stock", "stocked")).onHand).toBe(7);
			});

			test("updateVariantFields prices a declared variant (integer minor units + explicit currency) under a compare-and-set", async () => {
				const h = await makeStore();
				const declared = await declare(h, "prod-price", "large");

				const res = await h.store.updateVariantFields(
					{
						productId: productId("prod-price"),
						variantKey: "large",
						sku: sku("TEE-L"),
						price: money(cents(2599), currency("USD")),
					},
					idempotencyKey("price-1"),
					declared.updatedAt.toISOString(),
				);

				expect(res.ok).toBe(true);
				if (!res.ok) throw new Error("unreachable");
				expect(res.variant.sku).toBe("TEE-L");
				expect(res.variant.price).toEqual({ amount: 2599, currency: "USD" });
				// The edit never reaches the CMS-owned column.
				expect(res.variant.title).toBe("Variant large");
			});

			test("updateVariantFields preserves fields the edit omits", async () => {
				const h = await makeStore();
				const declared = await declare(h, "prod-part", "k");
				const priced = await h.store.updateVariantFields(
					{
						productId: productId("prod-part"),
						variantKey: "k",
						sku: sku("PART-1"),
						price: money(cents(500), currency("USD")),
					},
					idempotencyKey("part-1"),
					declared.updatedAt.toISOString(),
				);
				if (!priced.ok) throw new Error("unreachable");

				const res = await h.store.updateVariantFields(
					{
						productId: productId("prod-part"),
						variantKey: "k",
						price: money(cents(700), currency("USD")),
					},
					idempotencyKey("part-2"),
					priced.variant.updatedAt.toISOString(),
				);
				if (!res.ok) throw new Error("unreachable");
				expect(res.variant.price).toEqual({ amount: 700, currency: "USD" });
				expect(res.variant.sku).toBe("PART-1");
			});

			test("updateVariantFields returns not_found for an unknown variant key and an unknown product — never mints a row", async () => {
				const h = await makeStore();
				await declare(h, "prod-nf", "known");

				expect(
					await h.store.updateVariantFields(
						{ productId: productId("prod-nf"), variantKey: "ghost", sku: sku("GHOST") },
						idempotencyKey("nf-1"),
						"2026-07-10T00:00:00.000Z",
					),
				).toEqual({ ok: false, reason: "not_found" });
				expect(
					await h.store.updateVariantFields(
						{ productId: productId("ghost-product"), variantKey: "k", sku: sku("GHOST-2") },
						idempotencyKey("nf-2"),
						"2026-07-10T00:00:00.000Z",
					),
				).toEqual({ ok: false, reason: "not_found" });

				const rows = await h.store.listVariants(productId("prod-nf"));
				expect(rows.map((v) => v.variantKey)).toEqual(["known"]);
				expect(await h.store.listVariants(productId("ghost-product"))).toEqual([]);
			});

			test("updateVariantFields is an idempotent replay under the same key (the stale guard never fires)", async () => {
				const h = await makeStore();
				const declared = await declare(h, "prod-vrep", "k");
				const key = idempotencyKey("vrep-1");
				const input = {
					productId: productId("prod-vrep"),
					variantKey: "k",
					price: money(cents(900), currency("USD")),
				};
				const first = await h.store.updateVariantFields(
					input,
					key,
					declared.updatedAt.toISOString(),
				);
				expect(first.ok).toBe(true);

				const replay = await h.store.updateVariantFields(
					input,
					key,
					declared.updatedAt.toISOString(),
				);
				expect(replay.ok).toBe(true);
				if (!replay.ok) throw new Error("unreachable");
				expect(replay.variant.price).toEqual({ amount: 900, currency: "USD" });
			});

			test("updateVariantFields returns stale (with the current row) when expectedUpdatedAt mismatches", async () => {
				const h = await makeStore();
				await declare(h, "prod-vstale", "k");

				const res = await h.store.updateVariantFields(
					{ productId: productId("prod-vstale"), variantKey: "k", sku: sku("STALE-1") },
					idempotencyKey("vstale-1"),
					"1999-01-01T00:00:00.000Z",
				);
				expect(res).toMatchObject({ ok: false, reason: "stale" });
				if (res.ok || res.reason !== "stale") throw new Error("unreachable");
				expect(res.current.sku).toBeNull();
			});

			test("updateVariantFields refuses a silent currency switch on an already-priced variant", async () => {
				const h = await makeStore();
				const declared = await declare(h, "prod-vcur", "k");
				const priced = await h.store.updateVariantFields(
					{
						productId: productId("prod-vcur"),
						variantKey: "k",
						price: money(cents(1000), currency("USD")),
					},
					idempotencyKey("vcur-1"),
					declared.updatedAt.toISOString(),
				);
				if (!priced.ok) throw new Error("unreachable");

				const res = await h.store.updateVariantFields(
					{
						productId: productId("prod-vcur"),
						variantKey: "k",
						price: money(cents(1000), currency("EUR")),
					},
					idempotencyKey("vcur-2"),
					priced.variant.updatedAt.toISOString(),
				);
				expect(res).toMatchObject({ ok: false, reason: "currency_mismatch" });
				if (res.ok || res.reason !== "currency_mismatch") throw new Error("unreachable");
				expect(res.current.price).toEqual({ amount: 1000, currency: "USD" });
			});

			test("updateVariantFields refuses a variant price whose currency disagrees with the PRODUCT's", async () => {
				const h = await makeStore();
				// The product is priced in USD; a EUR size would give the product no
				// honest total, no honest picker and no honest cart.
				await seedEditable(h, "prod-vpc", { sku: "SKU-VPC", currency: "USD" });
				const declared = await declare(h, "prod-vpc", "k");

				const res = await h.store.updateVariantFields(
					{
						productId: productId("prod-vpc"),
						variantKey: "k",
						price: money(cents(1000), currency("EUR")),
					},
					idempotencyKey("vpc-1"),
					declared.updatedAt.toISOString(),
				);
				expect(res).toMatchObject({ ok: false, reason: "currency_mismatch" });

				// The product's own currency is accepted, so the refusal is the
				// disagreement's and not "variants cannot be priced".
				const ok = await h.store.updateVariantFields(
					{
						productId: productId("prod-vpc"),
						variantKey: "k",
						price: money(cents(1000), currency("USD")),
					},
					idempotencyKey("vpc-2"),
					declared.updatedAt.toISOString(),
				);
				expect(ok.ok).toBe(true);
			});

			test("updateVariantFields refuses a variant price whose currency disagrees with a SIBLING variant's (an unpriced product still has a currency)", async () => {
				const h = await makeStore();
				// The realistic variants case: no product-level price at all (a
				// mixed-price product has no honest parent cell), so the currency lives
				// on the sizes and they must still agree with each other.
				await h.store.upsert({ productId: productId("prod-vsib") }, idempotencyKey("vsib-seed"));
				const a = await declare(h, "prod-vsib", "large");
				const b = await declare(h, "prod-vsib", "small");

				const first = await h.store.updateVariantFields(
					{
						productId: productId("prod-vsib"),
						variantKey: "large",
						price: money(cents(3000), currency("GBP")),
					},
					idempotencyKey("vsib-1"),
					a.updatedAt.toISOString(),
				);
				expect(first.ok).toBe(true);

				const res = await h.store.updateVariantFields(
					{
						productId: productId("prod-vsib"),
						variantKey: "small",
						price: money(cents(2500), currency("USD")),
					},
					idempotencyKey("vsib-2"),
					b.updatedAt.toISOString(),
				);
				expect(res).toMatchObject({ ok: false, reason: "currency_mismatch" });

				const agreeing = await h.store.updateVariantFields(
					{
						productId: productId("prod-vsib"),
						variantKey: "small",
						price: money(cents(2500), currency("GBP")),
					},
					idempotencyKey("vsib-3"),
					b.updatedAt.toISOString(),
				);
				expect(agreeing.ok).toBe(true);
			});

			test("A SKU NAMES ONE SELLABLE UNIT: two live variants cannot share one, and a variant cannot take a live product's", async () => {
				const h = await makeStore();
				const other = await seedEditable(h, "prod-owner", { sku: "SKU-OWNED" });
				expect(other.sku).toBe("SKU-OWNED");
				await h.store.upsert({ productId: productId("prod-vsku") }, idempotencyKey("vsku-seed"));
				const a = await declare(h, "prod-vsku", "large");
				const b = await declare(h, "prod-vsku", "small");

				const first = await h.store.updateVariantFields(
					{ productId: productId("prod-vsku"), variantKey: "large", sku: sku("TEE-SHARED") },
					idempotencyKey("vsku-1"),
					a.updatedAt.toISOString(),
				);
				expect(first.ok).toBe(true);

				// Sibling variant reaching for the same sku: one inventory row cannot
				// belong to two sellable units.
				await expect(
					h.store.updateVariantFields(
						{ productId: productId("prod-vsku"), variantKey: "small", sku: sku("TEE-SHARED") },
						idempotencyKey("vsku-2"),
						b.updatedAt.toISOString(),
					),
				).rejects.toBeInstanceOf(SkuConflictError);

				// And a sku a live PRODUCT row holds is just as taken.
				await expect(
					h.store.updateVariantFields(
						{ productId: productId("prod-vsku"), variantKey: "small", sku: sku("SKU-OWNED") },
						idempotencyKey("vsku-3"),
						b.updatedAt.toISOString(),
					),
				).rejects.toBeInstanceOf(SkuConflictError);

				expect((await variantOf(h, "prod-vsku", "small")).sku).toBeNull();
			});

			test("an ORPHANED variant frees its sku for reuse, exactly like a soft-deleted product's", async () => {
				const h = await makeStore();
				await h.store.upsert({ productId: productId("prod-free") }, idempotencyKey("free-seed"));
				const a = await declare(h, "prod-free", "large");
				const applied = await h.store.updateVariantFields(
					{ productId: productId("prod-free"), variantKey: "large", sku: sku("FREE-1") },
					idempotencyKey("free-1"),
					a.updatedAt.toISOString(),
				);
				expect(applied.ok).toBe(true);
				await h.store.deactivateVariant(
					productId("prod-free"),
					"large",
					idempotencyKey("free-orphan"),
					"2026-07-10T01:00:00.000Z",
				);

				const b = await declare(h, "prod-free", "small");
				const reuse = await h.store.updateVariantFields(
					{ productId: productId("prod-free"), variantKey: "small", sku: sku("FREE-1") },
					idempotencyKey("free-2"),
					b.updatedAt.toISOString(),
				);
				expect(reuse.ok).toBe(true);
			});

			// -- the orphan state --------------------------------------------------

			test("deactivateVariant ORPHANS the row and retains it — sku, price and stock all intact (deactivation, never deletion)", async () => {
				const h = await makeStore();
				const declared = await declare(h, "prod-orph", "large", "Large");
				const priced = await h.store.updateVariantFields(
					{
						productId: productId("prod-orph"),
						variantKey: "large",
						sku: sku("ORPH-L"),
						price: money(cents(1500), currency("USD")),
					},
					idempotencyKey("orph-price"),
					declared.updatedAt.toISOString(),
				);
				expect(priced.ok).toBe(true);
				await h.seedStock("ORPH-L", 11);

				await h.store.deactivateVariant(
					productId("prod-orph"),
					"large",
					idempotencyKey("orph-1"),
					"2026-07-10T01:00:00.000Z",
				);

				// A distinct STATE, not an absence: the row still lists, flagged, still
				// holding the units and the price a live order line may reference.
				const row = await variantOf(h, "prod-orph", "large");
				expect(row.orphanedAt).not.toBeNull();
				expect(row.sku).toBe("ORPH-L");
				expect(row.price).toEqual({ amount: 1500, currency: "USD" });
				expect(row.onHand).toBe(11);
			});

			test("deactivateVariant is a stable no-op when replayed, on an already-orphaned row, and on an unknown key", async () => {
				const h = await makeStore();
				await declare(h, "prod-orph2", "k");
				await h.store.deactivateVariant(
					productId("prod-orph2"),
					"k",
					idempotencyKey("o2-1"),
					"2026-07-10T01:00:00.000Z",
				);
				const first = await variantOf(h, "prod-orph2", "k");

				await h.store.deactivateVariant(
					productId("prod-orph2"),
					"k",
					idempotencyKey("o2-2"),
					"2026-07-10T02:00:00.000Z",
				);
				expect((await variantOf(h, "prod-orph2", "k")).orphanedAt).toEqual(first.orphanedAt);

				// Unknown key / unknown product mint nothing.
				await h.store.deactivateVariant(
					productId("prod-orph2"),
					"ghost",
					idempotencyKey("o2-3"),
					"2026-07-10T02:00:00.000Z",
				);
				await h.store.deactivateVariant(
					productId("ghost-product"),
					"k",
					idempotencyKey("o2-4"),
					"2026-07-10T02:00:00.000Z",
				);
				expect(
					(await h.store.listVariants(productId("prod-orph2"))).map((v) => v.variantKey),
				).toEqual(["k"]);
				expect(await h.store.listVariants(productId("ghost-product"))).toEqual([]);
			});

			test("out-of-order presence converges: a STALE deactivate arriving after a newer declare leaves the variant live", async () => {
				const h = await makeStore();
				await h.store.upsertVariant(
					{
						productId: productId("prod-conv"),
						variantKey: "k",
						title: "Re-declared",
						contentUpdatedAt: "2026-07-10T02:00:00.000Z",
					},
					idempotencyKey("conv-1"),
				);

				// The delayed "the repeater row is gone", from a save that is OLDER than
				// the one that re-declared it. Applied, it would orphan a variant the
				// CMS currently declares, with nothing to heal it until the next save.
				await h.store.deactivateVariant(
					productId("prod-conv"),
					"k",
					idempotencyKey("conv-2"),
					"2026-07-10T01:00:00.000Z",
				);

				expect((await variantOf(h, "prod-conv", "k")).orphanedAt).toBeNull();
			});

			test("upsertVariant RESURRECTS an orphaned variant — the CMS declared the key again, and the stock comes back with it", async () => {
				const h = await makeStore();
				const declared = await declare(h, "prod-res", "large", "Large");
				const priced = await h.store.updateVariantFields(
					{ productId: productId("prod-res"), variantKey: "large", sku: sku("RES-L") },
					idempotencyKey("res-price"),
					declared.updatedAt.toISOString(),
				);
				expect(priced.ok).toBe(true);
				await h.seedStock("RES-L", 6);
				await h.store.deactivateVariant(
					productId("prod-res"),
					"large",
					idempotencyKey("res-orphan"),
					"2026-07-10T01:00:00.000Z",
				);
				expect((await variantOf(h, "prod-res", "large")).orphanedAt).not.toBeNull();

				// The deliberate DIVERGENCE from publish-never-resurrects: the orphan is
				// the CMS's own statement, so the CMS is the right authority to undo it,
				// and refusing would strand the units behind a key nobody can re-declare.
				await h.store.upsertVariant(
					{
						productId: productId("prod-res"),
						variantKey: "large",
						title: "Large",
						contentUpdatedAt: "2026-07-10T02:00:00.000Z",
					},
					idempotencyKey("res-back"),
				);

				const row = await variantOf(h, "prod-res", "large");
				expect(row.orphanedAt).toBeNull();
				expect(row.sku).toBe("RES-L");
				expect(row.onHand).toBe(6);
			});

			test("updateVariantFields returns not_found for an ORPHANED variant — an edit is not a resurrection", async () => {
				const h = await makeStore();
				const declared = await declare(h, "prod-oedit", "k");
				await h.store.deactivateVariant(
					productId("prod-oedit"),
					"k",
					idempotencyKey("oedit-1"),
					"2026-07-10T01:00:00.000Z",
				);

				expect(
					await h.store.updateVariantFields(
						{ productId: productId("prod-oedit"), variantKey: "k", sku: sku("OEDIT-1") },
						idempotencyKey("oedit-2"),
						declared.updatedAt.toISOString(),
					),
				).toEqual({ ok: false, reason: "not_found" });
				expect((await variantOf(h, "prod-oedit", "k")).sku).toBeNull();
			});

			// -- THE SKU-RENAME RULE, at variant grain -----------------------------
			//
			// The rule belongs to the `sku` COLUMN, not to one writer: `inventory` is
			// keyed by the bare sku and knows nothing about products or variants, so a
			// variant rename strands units exactly as a product rename did. Every case
			// below is its product-level sibling, one level down.

			describe("a variant sku rename carries its on-hand row, or refuses", () => {
				/** A declared, sku-bearing variant with a stocked inventory row;
				 *  returns the `updatedAt` its next guarded edit must pass back. */
				async function stockedVariant(
					h: ProductCommerceStoreHarness,
					pid: string,
					key: string,
					s: string,
					onHand?: number,
				): Promise<string> {
					const declared = await declare(h, pid, key);
					const res = await h.store.updateVariantFields(
						{ productId: productId(pid), variantKey: key, sku: sku(s) },
						idempotencyKey(`sv-${pid}-${key}`),
						declared.updatedAt.toISOString(),
					);
					if (!res.ok) throw new Error(`stockedVariant: ${pid}/${key} could not be priced`);
					if (onHand !== undefined) await h.seedStock(s, onHand);
					return res.variant.updatedAt.toISOString();
				}

				test("a rename CARRIES the on-hand count onto the new sku, and RETAINS the source at zero", async () => {
					const h = await makeStore();
					const wm = await stockedVariant(h, "prod-vc", "large", "VC-OLD", 40);
					expect((await variantOf(h, "prod-vc", "large")).onHand).toBe(40);

					const res = await h.store.updateVariantFields(
						{ productId: productId("prod-vc"), variantKey: "large", sku: sku("VC-NEW") },
						idempotencyKey("vc-rename"),
						wm,
					);

					expect(res.ok).toBe(true);
					const row = await variantOf(h, "prod-vc", "large");
					expect(row.sku).toBe("VC-NEW");
					// The 40 units followed the SIZE. Without the carry they stay under
					// the old label while the size starts again from a fresh zero.
					expect(row.onHand).toBe(40);
					// `0`, not `null`: a stock row is never deleted, because
					// `reservations.sku` references it.
					expect(await onHandOfSku(h, "probe-vc", "VC-OLD")).toBe(0);
				});

				test("renaming ONTO a sku that already has an inventory row refuses, naming both skus, and writes nothing", async () => {
					const h = await makeStore();
					const wm = await stockedVariant(h, "prod-vconf", "large", "VCONF-SRC", 5);
					// Units under a sku no live sellable unit holds — so the refusal is
					// genuinely the stock row's, not live-sku uniqueness in disguise.
					await h.seedStock("VCONF-TAKEN", 12);

					await expect(
						h.store.updateVariantFields(
							{ productId: productId("prod-vconf"), variantKey: "large", sku: sku("VCONF-TAKEN") },
							idempotencyKey("vconf-1"),
							wm,
						),
					).rejects.toMatchObject({
						name: "SkuStockConflictError",
						fromSku: "VCONF-SRC",
						toSku: "VCONF-TAKEN",
					});

					// ATOMIC: the variant row rolled back with the stock.
					const row = await variantOf(h, "prod-vconf", "large");
					expect(row.sku).toBe("VCONF-SRC");
					expect(row.onHand).toBe(5);
					expect(await onHandOfSku(h, "probe-vconf", "VCONF-TAKEN")).toBe(12);
				});

				test("occupied is occupied — a target row holding ZERO refuses exactly like a stocked one", async () => {
					const h = await makeStore();
					const wm = await stockedVariant(h, "prod-vzero", "large", "VZ-SRC", 8);
					await h.seedStock("VZ-TARGET", 0);

					await expect(
						h.store.updateVariantFields(
							{ productId: productId("prod-vzero"), variantKey: "large", sku: sku("VZ-TARGET") },
							idempotencyKey("vz-1"),
							wm,
						),
					).rejects.toBeInstanceOf(SkuStockConflictError);
					expect((await variantOf(h, "prod-vzero", "large")).onHand).toBe(8);
				});

				test("re-supplying the SAME sku is not a rename — the count is untouched and nothing refuses", async () => {
					const h = await makeStore();
					const wm = await stockedVariant(h, "prod-vsame", "large", "VSAME", 9);

					const res = await h.store.updateVariantFields(
						{
							productId: productId("prod-vsame"),
							variantKey: "large",
							sku: sku("VSAME"),
							price: money(cents(1200), currency("USD")),
						},
						idempotencyKey("vsame-1"),
						wm,
					);

					expect(res.ok).toBe(true);
					expect((await variantOf(h, "prod-vsame", "large")).onHand).toBe(9);
				});

				test("setting the FIRST sku on a variant that had none carries nothing, and ADOPTS an existing inventory row", async () => {
					const h = await makeStore();
					const declared = await declare(h, "prod-vfirst", "large");
					// Units already parked under the sku — the state a rename refuses.
					await h.seedStock("VFIRST", 33);

					const res = await h.store.updateVariantFields(
						{ productId: productId("prod-vfirst"), variantKey: "large", sku: sku("VFIRST") },
						idempotencyKey("vfirst-1"),
						declared.updatedAt.toISOString(),
					);

					// The same asymmetry the product level pins, and for the same reason:
					// there is no second count to reconcile, and adoption is how a
					// re-linked sellable unit gets its stock back after a failed sync.
					expect(res.ok).toBe(true);
					expect((await variantOf(h, "prod-vfirst", "large")).onHand).toBe(33);
				});

				test("a rename FROM a sku with no inventory row moves nothing and refuses nothing", async () => {
					const h = await makeStore();
					const wm = await stockedVariant(h, "prod-vnorow", "large", "VNOROW");
					expect((await variantOf(h, "prod-vnorow", "large")).onHand).toBeNull();

					const res = await h.store.updateVariantFields(
						{ productId: productId("prod-vnorow"), variantKey: "large", sku: sku("VFRESH") },
						idempotencyKey("vnorow-1"),
						wm,
					);
					expect(res.ok).toBe(true);
					expect((await variantOf(h, "prod-vnorow", "large")).onHand).toBe(0);
				});

				test("an idempotent REPLAY of a variant rename moves the units exactly once", async () => {
					const h = await makeStore();
					const wm = await stockedVariant(h, "prod-vrp", "large", "VRP-FROM", 30);
					const key = idempotencyKey("vrp-rename");
					const input = {
						productId: productId("prod-vrp"),
						variantKey: "large",
						sku: sku("VRP-TO"),
					};

					const first = await h.store.updateVariantFields(input, key, wm);
					expect(first.ok).toBe(true);
					expect((await variantOf(h, "prod-vrp", "large")).onHand).toBe(30);

					// The replay branch, pinned AHEAD of the staleness check: a second
					// carry could not stay quiet even if it wanted to, since VRP-TO now
					// has a row of its own and re-running the rule would REFUSE.
					const replay = await h.store.updateVariantFields(input, key, wm);
					expect(replay.ok).toBe(true);
					expect((await variantOf(h, "prod-vrp", "large")).onHand).toBe(30);
					expect(await onHandOfSku(h, "probe-vrp", "VRP-FROM")).toBe(0);
				});

				test("a stale or not_found variant edit naming a new sku moves nothing and claims nothing", async () => {
					const h = await makeStore();
					await stockedVariant(h, "prod-vguard", "large", "VGUARD", 6);

					const stale = await h.store.updateVariantFields(
						{ productId: productId("prod-vguard"), variantKey: "large", sku: sku("VGUARD-STALE") },
						idempotencyKey("vguard-1"),
						"1999-01-01T00:00:00.000Z",
					);
					expect(stale).toMatchObject({ ok: false, reason: "stale" });

					const missing = await h.store.updateVariantFields(
						{ productId: productId("prod-vguard"), variantKey: "ghost", sku: sku("VGUARD-GHOST") },
						idempotencyKey("vguard-2"),
						"1999-01-01T00:00:00.000Z",
					);
					expect(missing).toEqual({ ok: false, reason: "not_found" });

					expect((await variantOf(h, "prod-vguard", "large")).onHand).toBe(6);
					expect(await onHandOfSku(h, "probe-vguard", "VGUARD-STALE")).toBeNull();
				});

				test("a rename away from a variant sku with a LIVE hold is refused, naming the sku and the count", async () => {
					const h = await makeStore();
					const wm = await stockedVariant(h, "prod-vheld", "large", "VHELD", 20);
					await h.seedHold("VHELD", 3);

					// The hold's units are already out of on_hand and the hold cannot
					// follow the rename, so the whole write waits — at variant grain
					// exactly as at product grain.
					await expect(
						h.store.updateVariantFields(
							{ productId: productId("prod-vheld"), variantKey: "large", sku: sku("VHELD-NEW") },
							idempotencyKey("vheld-1"),
							wm,
						),
					).rejects.toMatchObject({ name: "SkuHeldStockError", sku: "VHELD", liveHolds: 1 });

					const row = await variantOf(h, "prod-vheld", "large");
					expect(row.sku).toBe("VHELD");
					expect(row.onHand).toBe(20);
					expect(await onHandOfSku(h, "probe-vheld", "VHELD-NEW")).toBeNull();
				});

				test("when BOTH refusals apply the live hold wins, at variant grain too", async () => {
					const h = await makeStore();
					const wm = await stockedVariant(h, "prod-vboth", "large", "VBOTH", 7);
					await h.seedHold("VBOTH", 1);
					await h.seedStock("VBOTH-TARGET", 9);

					await expect(
						h.store.updateVariantFields(
							{ productId: productId("prod-vboth"), variantKey: "large", sku: sku("VBOTH-TARGET") },
							idempotencyKey("vboth-1"),
							wm,
						),
					).rejects.toBeInstanceOf(SkuHeldStockError);
					expect((await variantOf(h, "prod-vboth", "large")).sku).toBe("VBOTH");
				});
			});
		});
	});
}
