import { cents, currency as toCurrency, money } from "../money/cents.js";
import type { IdempotencyKey, ProductId } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type {
	ProductCommerce,
	ProductCommerceStore,
	ProductCommerceUpdateResult,
	ProductCommerceView,
	ProductKind,
	ProductListFilter,
	ProductListPage,
	ProductListResult,
	ProductSummary,
	UpdateProductCommerceFieldsInput,
	UpsertProductCommerceInput,
} from "../ports/product-commerce-store.js";
import {
	InvalidLowStockThresholdError,
	isValidLowStockThreshold,
	MissingProductIdError,
	SkuConflictError,
} from "../product-commerce/errors.js";

/** Test-only seed shape for the admin-list contract — a direct product row (no
 *  upsert/idempotency-key dance), so a case can pin an EXACT `createdAt` per
 *  row (mirrors `SeedOrderSummaryRow`: distinct clocks for ordering, identical
 *  clocks for the tie-break). Mirrors the columns `KyselyProductCommerceStore.
 *  listProducts` reads, so the fake and the SQL agree byte-for-byte. */
export interface SeedProductSummaryRow {
	id: string;
	sku?: string | null;
	title?: string | null;
	priceCents?: number | null;
	currency?: string;
	productKind?: ProductKind;
	active?: boolean;
	createdAt: string;
	deletedAt?: string | null;
}

/** Descending code-unit string comparison (`>` first) — the SAME plain
 *  code-unit ordering `OrderStore`'s admin-list fake uses, so the two admin
 *  list fakes stay internally consistent (never `localeCompare`). */
function codeUnitDesc(a: string, b: string): number {
	return a > b ? -1 : a < b ? 1 : 0;
}

/** Escape-free substring test — the fake's stand-in for the SQL adapter's
 *  `lower(title) LIKE lower(:pattern) ESCAPE '\'`: a plain case-insensitive
 *  `includes`, since the fake never builds a LIKE pattern (nothing to escape
 *  here). */
function containsCaseInsensitive(haystack: string, needle: string): boolean {
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

export interface InMemoryProductCommerceStoreOptions {
	clock: Clock;
	/**
	 * The fake's stand-in for the real store's `inventory` LEFT JOIN — a plain
	 * lookup the harness seeds, feeding BOTH `listCommerceByIds`'s coarse
	 * `inStock` (Phase 2) and `listProducts`'s `onHand` projection.
	 *
	 * Returns `null` for "no inventory row", exactly like the SQL join miss it
	 * models — NOT `0`, which means a known sku that is out of stock. A lookup
	 * that collapses the two (e.g. `InMemoryInventoryStore.onHand`, which
	 * returns 0 for an unseeded sku) would make the fake disagree with every
	 * real adapter on the `onHand: null` case the contract pins. Defaults to
	 * "no inventory row" (`null`), so `inStock` stays coarsely false.
	 */
	inventoryOnHand?: (sku: string) => number | null;
}

/**
 * The IO-free `ProductCommerceStore` fake (Phase 1 step 2) — the first
 * adapter the contract suite runs against, mirroring `InMemoryInventoryStore`
 * (Phase 0 §0.2c).
 *
 * Upsert semantics: undefined fields on a later upsert PRESERVE the stored
 * value; `null` clears a nullable field. A replay whose incoming key equals
 * the stored `idempotencyKey` is a no-op returning the existing row
 * unchanged; any other key applies the update and overwrites the stored key
 * (per-row compare-on-write — Phase 1 §4, NOT a global unique constraint).
 * A sync upsert whose `contentUpdatedAt` is strictly older than the stored
 * watermark is a stale no-op (out-of-order hook delivery converges); the
 * publish gate (`activate`/`deactivate`) converges the same way under its own
 * separate gate watermark (see `#activeWatermark`). A LIVE
 * row's sku is unique across live rows only (mirrors the store's
 * `UNIQUE (sku) WHERE deleted_at IS NULL` partial index): assigning a sku
 * held by another non-deleted row throws; a sku freed by a soft delete is
 * reusable.
 */
export class InMemoryProductCommerceStore implements ProductCommerceStore {
	#clock: Clock;
	#rows = new Map<string, ProductCommerce>();
	/**
	 * The publish-gate ordering watermark (the last `contentUpdatedAt` a
	 * winning `activate`/`deactivate` applied), kept in a DEDICATED map rather
	 * than reusing the row's `contentUpdatedAt` (the sync/upsert watermark): a
	 * plain `content:afterSave` advances that one WITHOUT being a lifecycle
	 * event, so sharing it would let a save poison the gate and let a stale
	 * lifecycle POST win. Mirrors the store's separate `active_updated_at`
	 * column. Absent (never transitioned) is treated as `-infinity`, so the
	 * first transition always wins.
	 */
	#activeWatermark = new Map<string, string>();
	#inventoryOnHand: (sku: string) => number | null;

	constructor(options: InMemoryProductCommerceStoreOptions) {
		this.#clock = options.clock;
		this.#inventoryOnHand = options.inventoryOnHand ?? (() => null);
	}

	async upsert(input: UpsertProductCommerceInput, key: IdempotencyKey): Promise<ProductCommerce> {
		if (typeof input.productId !== "string" || input.productId.length === 0) {
			throw new MissingProductIdError();
		}

		const now = this.#clock.now();
		const existing = this.#rows.get(input.productId);

		if (existing !== undefined) {
			if (existing.idempotencyKey === key) {
				// Replay with the same stored key: a provable no-op.
				return existing;
			}
			if (
				input.contentUpdatedAt !== undefined &&
				existing.contentUpdatedAt !== null &&
				input.contentUpdatedAt < existing.contentUpdatedAt
			) {
				// Stale sync (strictly older content revision than the stored
				// watermark): a delayed/re-ordered hook delivery never overwrites
				// fresher data.
				return existing;
			}
			// After the no-op guards, mirroring the store: a skipped DO UPDATE
			// never contends for the sku index.
			this.#assertLiveSkuFree(input);
			const updated: ProductCommerce = {
				...existing,
				sku: input.sku !== undefined ? input.sku : existing.sku,
				price: input.price !== undefined ? input.price : existing.price,
				title: input.title !== undefined ? input.title : existing.title,
				taxClass: input.taxClass !== undefined ? input.taxClass : existing.taxClass,
				weightGrams: input.weightGrams !== undefined ? input.weightGrams : existing.weightGrams,
				lengthMm: input.lengthMm !== undefined ? input.lengthMm : existing.lengthMm,
				widthMm: input.widthMm !== undefined ? input.widthMm : existing.widthMm,
				heightMm: input.heightMm !== undefined ? input.heightMm : existing.heightMm,
				productKind: input.productKind ?? existing.productKind,
				idempotencyKey: key,
				contentUpdatedAt:
					input.contentUpdatedAt !== undefined ? input.contentUpdatedAt : existing.contentUpdatedAt,
				updatedAt: now,
			};
			this.#rows.set(input.productId, updated);
			return updated;
		}

		this.#assertLiveSkuFree(input);
		const created: ProductCommerce = {
			productId: input.productId,
			sku: input.sku ?? null,
			price: input.price ?? null,
			title: input.title ?? null,
			taxClass: input.taxClass ?? null,
			// compare-at / cost / inventory-policy are EDIT-ONLY (set via
			// `updateCommerceFields`, never a CMS-sync upsert) — a fresh row always
			// starts with them at their defaults, and a later upsert PRESERVES them
			// (they are not part of `UpsertProductCommerceInput`).
			compareAtPrice: null,
			unitCost: null,
			inventoryPolicy: "deny",
			weightGrams: input.weightGrams ?? null,
			lengthMm: input.lengthMm ?? null,
			widthMm: input.widthMm ?? null,
			heightMm: input.heightMm ?? null,
			productKind: input.productKind ?? "physical",
			active: false,
			deletedAt: null,
			idempotencyKey: key,
			contentUpdatedAt: input.contentUpdatedAt ?? null,
			createdAt: now,
			updatedAt: now,
		};
		this.#rows.set(input.productId, created);
		return created;
	}

	/** Mirrors the store's `UNIQUE (sku) WHERE deleted_at IS NULL` partial
	 *  index: only LIVE rows contend for a sku. Throws the structured domain
	 *  `SkuConflictError` (review F2), exactly like the Kysely store's
	 *  narrowly-scoped constraint-violation catch. */
	#assertLiveSkuFree(input: UpsertProductCommerceInput): void {
		if (input.sku === undefined) return;
		for (const row of this.#rows.values()) {
			if (row.productId !== input.productId && row.sku === input.sku && row.deletedAt === null) {
				throw new SkuConflictError(input.sku);
			}
		}
	}

	async getByProductId(productId: ProductId): Promise<ProductCommerce | null> {
		return this.#rows.get(productId) ?? null;
	}

	/**
	 * Guarded admin edit (port doc): optimistic compare-and-set on `updatedAt`
	 * with the EXACT guard order the Kysely store's zero-row classifier uses —
	 * not_found (missing / soft-deleted) FIRST, then idempotent replay, then
	 * stale (updatedAt CAS), then currency integrity, then apply. NEVER touches
	 * active/deletedAt/watermarks.
	 */
	async updateCommerceFields(
		input: UpdateProductCommerceFieldsInput,
		key: IdempotencyKey,
		expectedUpdatedAt: string,
	): Promise<ProductCommerceUpdateResult> {
		const existing = this.#rows.get(input.productId);
		// 1. An edit is not a create: unknown / soft-deleted ⇒ not_found — BEFORE
		//    the replay check, exactly like the Kysely classifier (its UPDATE's
		//    `deleted_at IS NULL` guard means a deleted row never applies, and the
		//    re-read classifies the tombstone first): a same-key replay arriving
		//    after the row was (soft-)deleted reports not_found, never a spurious
		//    ok over a tombstone.
		if (existing === undefined || existing.deletedAt !== null) {
			return { ok: false, reason: "not_found" };
		}
		// 2. Replay: a same-key retry against the LIVE row is a no-op even after
		//    updatedAt moved (replay precedence over the CAS).
		if (existing.idempotencyKey === key) {
			return { ok: true, product: existing };
		}
		// 3. Optimistic CAS on updatedAt (ISO text): a mismatch means another
		//    writer moved the row since the admin loaded it.
		if (existing.updatedAt.toISOString() !== expectedUpdatedAt) {
			return { ok: false, reason: "stale", current: existing };
		}
		// 4a. Currency integrity: a price edit never silently switches currency.
		if (
			input.price !== undefined &&
			existing.price !== null &&
			existing.price.currency !== input.price.currency
		) {
			return { ok: false, reason: "currency_mismatch", current: existing };
		}
		// 4b. compare-at / cost supplied WITHOUT a price in the same edit must match
		//     the STORED price currency (which is the row currency, since price
		//     currency can never change once set). This includes the "not priced
		//     yet" case: a null stored price currency ⇒ nothing to match ⇒ mismatch
		//     (compare-at / cost require a priced product). When a price IS in the
		//     same edit, the within-edit currencies were checked in the use-case and
		//     4a fixed the row currency, so no separate guard is needed here.
		if (input.price === undefined) {
			const rowCurrency = existing.price?.currency ?? null;
			for (const extra of [input.compareAtPrice, input.unitCost]) {
				if (extra != null && extra.currency !== rowCurrency) {
					return { ok: false, reason: "currency_mismatch", current: existing };
				}
			}
		}
		// 5. Apply. Live-sku collisions throw SkuConflictError, exactly like upsert.
		this.#assertLiveSkuFree(input);
		const updated: ProductCommerce = {
			...existing,
			sku: input.sku !== undefined ? input.sku : existing.sku,
			price: input.price !== undefined ? input.price : existing.price,
			// `title` is ABSENT from the edit input by design — the CMS content sync
			// is its sole writer (ADR-0013), so an edit always preserves it.
			taxClass: input.taxClass !== undefined ? input.taxClass : existing.taxClass,
			compareAtPrice:
				input.compareAtPrice !== undefined ? input.compareAtPrice : existing.compareAtPrice,
			unitCost: input.unitCost !== undefined ? input.unitCost : existing.unitCost,
			inventoryPolicy:
				input.inventoryPolicy !== undefined ? input.inventoryPolicy : existing.inventoryPolicy,
			weightGrams: input.weightGrams !== undefined ? input.weightGrams : existing.weightGrams,
			lengthMm: input.lengthMm !== undefined ? input.lengthMm : existing.lengthMm,
			widthMm: input.widthMm !== undefined ? input.widthMm : existing.widthMm,
			heightMm: input.heightMm !== undefined ? input.heightMm : existing.heightMm,
			productKind: input.productKind ?? existing.productKind,
			idempotencyKey: key,
			updatedAt: this.#clock.now(),
		};
		this.#rows.set(input.productId, updated);
		return { ok: true, product: updated };
	}

	/**
	 * Bulk snapshot read (port doc): the batch companion to `getByProductId`,
	 * the RAW row read the two checkout paths use to kill the per-cart-line
	 * N+1. No deletedAt / sku / price filtering (that is `listCommerceByIds`);
	 * missing ids are simply absent from the Map; duplicate ids collapse.
	 */
	async getManyByProductId(productIds: ProductId[]): Promise<Map<ProductId, ProductCommerce>> {
		const result = new Map<ProductId, ProductCommerce>();
		for (const id of productIds) {
			if (result.has(id)) continue; // duplicate id: already resolved.
			const row = this.#rows.get(id);
			if (row === undefined) continue; // miss: absent from the Map, never null.
			result.set(id, row);
		}
		return result;
	}

	/**
	 * Batch catalog read (Phase 2 §6) — mirrors the Kysely store's single
	 * `product_commerce LEFT JOIN inventory` statement: only commerce-complete
	 * live rows become views; `inStock` is the coarse `on_hand > 0`; missing
	 * ids are omitted; duplicates collapse. Inactive rows are RETURNED with
	 * `active: false` — the purchasability gate is the plugin's `joinProduct`
	 * (`purchasable ⟺ commerce !== null && commerce.active`), not the store
	 * (see the port doc).
	 */
	async listCommerceByIds(productIds: ProductId[]): Promise<ProductCommerceView[]> {
		const views: ProductCommerceView[] = [];
		const seen = new Set<string>();
		for (const id of productIds) {
			if (seen.has(id)) continue;
			seen.add(id);
			const row = this.#rows.get(id);
			if (row === undefined || row.deletedAt !== null) continue;
			if (row.sku === null || row.price === null) continue;
			views.push({
				productId: row.productId,
				sku: row.sku,
				price: row.price,
				// A join miss (`null`) is coarsely "not in stock", exactly like 0.
				inStock: (this.#inventoryOnHand(row.sku) ?? 0) > 0,
				active: row.active,
			});
		}
		return views;
	}

	// -- writes ---------------------------------------------------------------

	/** The afterPublish→activate follow-up (port doc): unknown/soft-deleted/
	 *  already-active rows are stable no-ops; a soft-deleted product is never
	 *  resurrected by a publish; a stale `contentUpdatedAt` (strictly older
	 *  than the gate watermark a newer lifecycle event applied) is a no-op so
	 *  out-of-order publish/unpublish delivery converges. A winning flip
	 *  advances the gate watermark. */
	async activate(
		productId: ProductId,
		key: IdempotencyKey,
		contentUpdatedAt: string,
	): Promise<void> {
		const existing = this.#rows.get(productId);
		if (existing === undefined) return; // unknown product_id: nothing to activate.
		if (existing.deletedAt !== null) return; // soft-deleted: must not resurrect.
		if (existing.active) return; // already active: stable no-op under replay.
		if (this.#staleGate(productId, contentUpdatedAt)) return; // stale out-of-order publish.
		this.#rows.set(productId, {
			...existing,
			active: true,
			idempotencyKey: key,
			updatedAt: this.#clock.now(),
		});
		this.#activeWatermark.set(productId, contentUpdatedAt);
	}

	/** The afterUnpublish→deactivate follow-up (port doc): the mirror of
	 *  `activate`. Unknown/soft-deleted/already-inactive rows are stable
	 *  no-ops; the tombstone is never touched (deactivation is not a soft
	 *  delete, and a deleted row is never resurrected or re-stamped); a stale
	 *  `contentUpdatedAt` is a no-op so out-of-order delivery converges. A
	 *  winning flip advances the gate watermark. */
	async deactivate(
		productId: ProductId,
		key: IdempotencyKey,
		contentUpdatedAt: string,
	): Promise<void> {
		const existing = this.#rows.get(productId);
		if (existing === undefined) return; // unknown product_id: nothing to deactivate.
		if (existing.deletedAt !== null) return; // soft-deleted: leave the tombstone alone.
		if (!existing.active) return; // already inactive: stable no-op under replay.
		if (this.#staleGate(productId, contentUpdatedAt)) return; // stale out-of-order unpublish.
		this.#rows.set(productId, {
			...existing,
			active: false,
			idempotencyKey: key,
			updatedAt: this.#clock.now(),
		});
		this.#activeWatermark.set(productId, contentUpdatedAt);
	}

	/** A lifecycle POST is stale iff the gate watermark a newer transition
	 *  already applied is STRICTLY NEWER than this one (mirrors the store's
	 *  `active_updated_at <= :t` guard; ISO-8601 lexicographic = chronological).
	 *  Absent watermark (never transitioned) ⇒ never stale — first flip wins. */
	#staleGate(productId: string, contentUpdatedAt: string): boolean {
		const applied = this.#activeWatermark.get(productId);
		return applied !== undefined && applied > contentUpdatedAt;
	}

	async softDelete(productId: ProductId, key: IdempotencyKey): Promise<void> {
		const existing = this.#rows.get(productId);
		if (existing === undefined) return; // unknown product_id: no-op.
		if (existing.deletedAt !== null) return; // already deleted: stable no-op.
		this.#rows.set(productId, {
			...existing,
			active: false,
			deletedAt: this.#clock.now(),
			idempotencyKey: key,
			updatedAt: this.#clock.now(),
		});
	}

	// -- Admin Products console: view-only keyset list (admin-UX Increment 2) --

	/** The ONE `ProductListFilter` predicate (mirrors `OrderStore`'s
	 *  `#matchesFilter` / the Kysely adapter's shared predicate builder) —
	 *  excludes soft-deleted rows UNLESS `filter.deleted: true` requests the
	 *  archive view (product lifecycle surfacing — see the port doc). */
	/**
	 * Validates `filter.lowStockThreshold` BEFORE any row is considered (port
	 * doc — `InvalidLowStockThresholdError`), via the shared
	 * `isValidLowStockThreshold` guard every adapter calls. Checked ONCE per
	 * `listProducts`/`countProducts` invocation, never inside `#matchesFilter`
	 * (which only runs per EXISTING row): an empty store must throw exactly
	 * like a populated one, mirroring the SQL adapters, whose parameter
	 * binding rejects an out-of-domain value independently of how many rows
	 * the query would have matched. Short-circuits BEFORE any `>` comparison
	 * ever runs — the fix for the divergence `InvalidLowStockThresholdError`'s
	 * doc records (a naive `onHand > threshold` lets `NaN` silently decide
	 * "nothing is low stock" instead of failing loudly).
	 */
	#assertValidLowStockThreshold(filter: ProductListFilter): void {
		if (
			filter.lowStockThreshold !== undefined &&
			!isValidLowStockThreshold(filter.lowStockThreshold)
		) {
			throw new InvalidLowStockThresholdError(filter.lowStockThreshold);
		}
	}

	#matchesFilter(row: ProductCommerce, filter: ProductListFilter): boolean {
		const wantDeleted = filter.deleted === true;
		if (wantDeleted !== (row.deletedAt !== null)) return false;
		if (filter.active !== undefined && row.active !== filter.active) return false;
		if (filter.productKind !== undefined && row.productKind !== filter.productKind) return false;
		if (filter.search !== undefined) {
			const bySku = row.sku !== null && row.sku.toLowerCase() === filter.search.toLowerCase();
			const byTitle = row.title !== null && containsCaseInsensitive(row.title, filter.search);
			if (!bySku && !byTitle) return false;
		}
		if (filter.lowStockThreshold !== undefined) {
			// Mirrors the SQL adapter's LEFT JOIN predicate: a row with no sku (or
			// a sku with no inventory row) resolves to `null` — UNKNOWN stock,
			// never "low" — so it fails this half regardless of the threshold.
			const onHand = row.sku === null ? null : this.#inventoryOnHand(row.sku);
			if (onHand === null || onHand > filter.lowStockThreshold) return false;
		}
		return true;
	}

	async listProducts(filter: ProductListFilter, page: ProductListPage): Promise<ProductListResult> {
		// EXACT parity with `KyselyProductCommerceStore.listProducts` (mirrors
		// `InMemoryOrderStore.listOrders`, MOD-5): same filters (via the shared
		// `#matchesFilter` predicate), same `created_at DESC, product_id DESC`
		// order, same `limit + 1` next-page detection.
		this.#assertValidLowStockThreshold(filter);
		const cursor = page.cursor ?? null;

		const matched = [...this.#rows.values()]
			.filter((row) => {
				if (!this.#matchesFilter(row, filter)) return false;
				if (cursor !== null) {
					const createdAt = row.createdAt.toISOString();
					if (createdAt > cursor.createdAt) return false;
					if (createdAt === cursor.createdAt && row.productId >= cursor.productId) return false;
				}
				return true;
			})
			.toSorted((a, b) => {
				const aCreated = a.createdAt.toISOString();
				const bCreated = b.createdAt.toISOString();
				return aCreated === bCreated
					? codeUnitDesc(a.productId, b.productId) // product_id DESC
					: codeUnitDesc(aCreated, bCreated); // created_at DESC
			});

		const window = matched.slice(0, page.limit + 1);
		const hasMore = window.length > page.limit;
		const rows = hasMore ? window.slice(0, page.limit) : window;
		const last = rows.at(-1);
		const nextCursor =
			hasMore && last !== undefined
				? { createdAt: last.createdAt.toISOString(), productId: last.productId }
				: null;
		return { products: rows.map((row) => this.#toSummary(row)), nextCursor };
	}

	/** Count under the SAME `#matchesFilter` predicate `listProducts` pages with
	 *  (MOD-5) — one predicate, so a count and the list it captions can never
	 *  disagree. No cursor: a count covers the whole filtered set, not a page. */
	async countProducts(filter: ProductListFilter): Promise<number> {
		this.#assertValidLowStockThreshold(filter);
		let count = 0;
		for (const row of this.#rows.values()) if (this.#matchesFilter(row, filter)) count++;
		return count;
	}

	/** Count LIVE products referencing a tax class (port doc) — the delete-in-use
	 *  guard's product half. Soft-deleted rows are historical, not live
	 *  dependencies, so they never block reclaiming a class id. */
	async countByTaxClass(taxClassId: string): Promise<number> {
		let count = 0;
		for (const row of this.#rows.values()) {
			if (row.deletedAt === null && row.taxClass === taxClassId) count++;
		}
		return count;
	}

	#toSummary(row: ProductCommerce): ProductSummary {
		return {
			productId: row.productId,
			sku: row.sku,
			title: row.title,
			price: row.price,
			productKind: row.productKind,
			active: row.active,
			// Mirrors the adapters' LEFT JOIN: a row with NO sku can never match
			// an inventory row, so it lands on the same `null` ("unknown") the
			// lookup returns for an unseeded sku. Never 0.
			onHand: row.sku === null ? null : this.#inventoryOnHand(row.sku),
			deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
			createdAt: row.createdAt.toISOString(),
		};
	}

	/** TEST-ONLY: directly seed a product row for the admin-list contract with
	 *  an EXACT `createdAt` (mirrors `InMemoryOrderStore.seedSummaryOrder`). Not
	 *  part of `ProductCommerceStore`. */
	seedProductRow(row: SeedProductSummaryRow): void {
		const pid = row.id as ProductId;
		const created = new Date(row.createdAt);
		this.#rows.set(row.id, {
			productId: pid,
			sku: row.sku !== undefined ? (row.sku as ProductCommerce["sku"]) : null,
			price:
				row.priceCents !== undefined && row.priceCents !== null
					? money(cents(row.priceCents), toCurrency(row.currency ?? "USD"))
					: null,
			title: row.title ?? null,
			taxClass: null,
			compareAtPrice: null,
			unitCost: null,
			inventoryPolicy: "deny",
			weightGrams: null,
			lengthMm: null,
			widthMm: null,
			heightMm: null,
			productKind: row.productKind ?? "physical",
			active: row.active ?? false,
			deletedAt:
				row.deletedAt !== undefined && row.deletedAt !== null ? new Date(row.deletedAt) : null,
			idempotencyKey: `seed-${row.id}` as IdempotencyKey,
			contentUpdatedAt: null,
			createdAt: created,
			updatedAt: created,
		});
	}
}
