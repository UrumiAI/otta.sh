/**
 * `ProductCommerceStore` over the EmDash plugin-storage primitives.
 *
 * The SQL adapter this replaces leaned on four database features that do not
 * exist here, and each one becomes a document:
 *
 * | The SQL | Here |
 * |---|---|
 * | `INSERT … ON CONFLICT (product_id) DO UPDATE … WHERE <two guards>` | one `compareAndSet` on `product_commerce/{productId}` whose guards are computed in JS against the value it just read |
 * | the CAS on `updated_at` plus a zero-row classifier | the same classifier, in the same order, inside that compare-and-set — with the document revision as a second, cheaper staleness check |
 * | two **partial** unique indexes (`WHERE deleted_at IS NULL`, `WHERE orphaned_at IS NULL`) plus reciprocal cross-table checks | ONE `sku_owners/{sku}` claim document (ADR-0019 R4) |
 * | a written-down lock order over `product_commerce → inventory → product_variants` | variants EMBEDDED in the product document, so there is one revision to win and no order to get wrong; plus the intent-claim carry in `sku-stock-transfer.ts` |
 *
 * **The guard order is the specification, and it is unchanged.** For both guarded
 * editors: `not_found` (unknown or tombstoned) → same-key replay returns `ok` →
 * `stale` → the currency mismatches → apply. For the sku axis, on every writer:
 * `SkuConflictError` (another live sellable unit holds the sku) outranks
 * `SkuHeldStockError` (the source still has a live hold), which outranks
 * `SkuStockConflictError` (the target already has an inventory document). The
 * first is decided by the claim document, the other two inside the carry — which
 * is exactly the SQL adapter's order, and the reason it is written down here is
 * that nothing in the document model enforces it by construction.
 *
 * **What the lists can and cannot push into the store.** `query`'s filter is
 * AND-only with no substring, no negation and no OR (ADR-0019 §6). So:
 *
 * - the tombstone axis is an indexed THREE-state `lifecycle` field rather than a
 *   nullable `deletedAt`, because "tombstoned" is a negation of "null" and the
 *   algebra has none — and because a third state is needed anyway for a document
 *   that holds variants but no product row;
 * - `active` and `productKind` are indexed equalities, pushed down;
 * - `search` is a case-insensitive SUBSTRING on the title OR an exact match on the
 *   sku — an OR of which one half no index can serve — so it is resolved IN MEMORY
 *   over the rows the indexed axes narrowed;
 * - `lowStockThreshold` pairs each candidate with its `inventory` document. There
 *   is no join, so this is a read per candidate sku, memoized per call and issued
 *   in parallel per page. The port's "never an N+1 of per-row reads" is a
 *   statement about not making the CALLER pay a round trip per row, and that still
 *   holds; a document store cannot make it one statement.
 *
 * The scan is bounded exactly as the order store's is: reaching the page ceiling
 * with rows still owed is a typed `ScanPageLimitError`, never a silently short
 * list.
 */
import {
	InvalidLowStockThresholdError,
	isValidLowStockThreshold,
	MissingProductIdError,
	MissingVariantKeyError,
	SkuConflictError,
	type Clock,
	type IdempotencyKey,
	type ProductCommerce,
	type ProductCommerceStore,
	type ProductCommerceUpdateResult,
	type ProductCommerceView,
	type ProductId,
	type ProductListFilter,
	type ProductListPage,
	type ProductListResult,
	type ProductVariant,
	type ProductVariantSummary,
	type ProductVariantUpdateResult,
	type Sku,
	type UpdateProductCommerceFieldsInput,
	type UpdateProductVariantFieldsInput,
	type UpsertProductCommerceInput,
	type UpsertProductVariantInput,
} from "@otta-sh/domain";
import {
	CAS_RETRY,
	casDone,
	withCasRetry,
	type CasRetryOptions,
	type CasStep,
} from "./cas-retry.js";
import { collectionOf } from "./collection-of.js";
import { ScanPageLimitError } from "./errors.js";
import {
	INVENTORY_COLLECTION,
	INVENTORY_MOVEMENTS_COLLECTION,
	type InventoryDoc,
} from "./inventory-documents.js";
import {
	codeUnitAsc,
	codeUnitDesc,
	hasProductRow,
	isOwnedBy,
	liveVariants,
	newShellProductDoc,
	newSkuOwnerDoc,
	newVariantDoc,
	normalizeProductDoc,
	PRODUCT_COMMERCE_COLLECTION,
	publishKeyFor,
	resolveProductCurrency,
	SKU_OWNERS_COLLECTION,
	toProductCommerce,
	toProductSummary,
	toProductVariant,
	toVariantSummary,
	type ProductCommerceDoc,
	type ProductVariantDoc,
	type SkuOwnerDoc,
	type SkuOwnerRef,
} from "./product-commerce-documents.js";
import { SkuStockTransfer, type SkuRenameLedgerDoc } from "./sku-stock-transfer.js";
import type { OrderBy, StorageAccess, StorageCollection, WhereClause } from "./storage-access.js";

/** The host clamps `limit` at 100, so a scan pages at the ceiling. */
const LIST_PAGE_SIZE = 100;

/** Default page ceiling for a bounded scan. 1000 × 100 pointers. */
const MAX_LIST_PAGES = 1000;

export interface EmdashProductCommerceStoreOptions {
	/**
	 * The collections the plugin descriptor declared. Both
	 * `PRODUCT_COMMERCE_COLLECTIONS` entries AND the `inventory` /
	 * `inventory_movements` entries of `INVENTORY_COLLECTIONS` must be present:
	 * the stock projections and the rename carry read and write the inventory
	 * documents, which this store shares with `EmdashInventoryStore` rather than
	 * duplicating.
	 */
	storage: StorageAccess;
	/** Timestamps come from here, never from `Date.now()` directly. */
	clock: Clock;
	/** Override the compare-and-set attempt ceiling (see `CAS_MAX_ATTEMPTS`). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent — how contention is measured. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Override the retry backoff sleep (a suite on fake timers supplies its own). */
	sleep?: CasRetryOptions["sleep"];
	/** Override the backoff jitter source, to make a retry schedule deterministic. */
	random?: CasRetryOptions["random"];
	/** Page ceiling for the admin list's bounded scan. Default 1000. */
	maxListPages?: number;
}

/** What a sku claim taken by an applying write leaves for the caller to finish. */
interface SkuTakeover {
	/** The sku whose claim to release once the write has committed (a rename's source). */
	readonly releaseSku: string | null;
}

/** One resolved sku claim: whether it was already ours, and whether we just took it. */
interface SkuClaim {
	/** The claim was ALREADY live and ours before this call touched it. */
	readonly alreadyOurs: boolean;
	/** This call created the claim (or took over a released one) and owns the rollback. */
	readonly createdNow: boolean;
}

export class EmdashProductCommerceStore implements ProductCommerceStore {
	readonly #products: StorageCollection<ProductCommerceDoc>;
	readonly #skuOwners: StorageCollection<SkuOwnerDoc>;
	readonly #inventory: StorageCollection<InventoryDoc>;
	readonly #transfer: SkuStockTransfer;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;
	readonly #maxListPages: number;

	constructor(options: EmdashProductCommerceStoreOptions) {
		this.#products = collectionOf<ProductCommerceDoc>(options.storage, PRODUCT_COMMERCE_COLLECTION);
		this.#skuOwners = collectionOf<SkuOwnerDoc>(options.storage, SKU_OWNERS_COLLECTION);
		this.#inventory = collectionOf<InventoryDoc>(options.storage, INVENTORY_COLLECTION);
		this.#clock = options.clock;
		this.#retry = {
			maxAttempts: options.maxCasAttempts,
			onAttempts: options.onCasAttempts,
			sleep: options.sleep,
			random: options.random,
		};
		this.#maxListPages = options.maxListPages ?? MAX_LIST_PAGES;
		this.#transfer = new SkuStockTransfer({
			inventory: this.#inventory,
			// The rename ledger shares `inventory_movements` with the per-key movement
			// claims but never their id space; see `SkuRenameLedgerDoc`.
			ledger: collectionOf<SkuRenameLedgerDoc>(options.storage, INVENTORY_MOVEMENTS_COLLECTION),
			clock: options.clock,
			retry: this.#retry,
		});
	}

	/**
	 * Finish a sku carry that `inventory/{sku}` still has stamped — the sweeper and
	 * replayer entry point, exposed because the coupling it completes is the one
	 * thing in this store that spans two documents.
	 *
	 * Returns true when a stamp was found and completed. Safe to call on any sku at
	 * any time: with no stamp it is a single read.
	 */
	completePendingSkuTransfer(sku: string): Promise<boolean> {
		return this.#transfer.completePending(sku);
	}

	// -- reads -----------------------------------------------------------------

	async getByProductId(productId: ProductId): Promise<ProductCommerce | null> {
		const doc = await this.#products.get(productId);
		if (doc === null || !hasProductRow(doc)) return null;
		return toProductCommerce(doc);
	}

	/**
	 * Bulk snapshot read: the RAW row per id, with `getByProductId`'s semantics and
	 * NOT `listCommerceByIds`'s — a soft-deleted, unpriced or sku-less row comes
	 * back as-is, because every caller does its own per-line checks.
	 *
	 * Missing ids are ABSENT from the map, never null; duplicates collapse. The
	 * reads are issued together, which is the document store's version of the one
	 * round trip this method exists to buy.
	 */
	async getManyByProductId(productIds: ProductId[]): Promise<Map<ProductId, ProductCommerce>> {
		const unique = [...new Set(productIds)];
		const docs = await Promise.all(unique.map((id) => this.#products.get(id)));
		const result = new Map<ProductId, ProductCommerce>();
		for (const [index, doc] of docs.entries()) {
			const id = unique[index];
			if (id === undefined || doc === null || !hasProductRow(doc)) continue;
			result.set(id, toProductCommerce(doc));
		}
		return result;
	}

	/**
	 * Batch catalog read: a view per commerce-complete LIVE row (sku and price
	 * set), inactive rows included and FLAGGED — the store reports state, and the
	 * purchasability decision lives in the plugin's join.
	 *
	 * `inStock` is the coarse `onHand > 0`, resolved inside the store from the
	 * inventory documents rather than handed back to the caller as a second
	 * round trip. That is the invariant the port protects; what it cannot ask a
	 * document store for is a single statement.
	 */
	async listCommerceByIds(productIds: ProductId[]): Promise<ProductCommerceView[]> {
		const unique = [...new Set(productIds)];
		const docs = await Promise.all(unique.map((id) => this.#products.get(id)));
		const complete = docs.filter(
			(doc): doc is ProductCommerceDoc =>
				doc !== null && doc.lifecycle === "live" && doc.sku !== null && doc.price !== null,
		);
		const stock = this.#stockReader();
		return Promise.all(
			complete.map(async (doc) => {
				const sku = doc.sku as Sku;
				const price = doc.price;
				if (price === null) throw new Error("unreachable: filtered above");
				return {
					productId: doc.productId,
					sku,
					price,
					// A missing document (`null`) is coarsely "not in stock", exactly like 0.
					inStock: ((await stock(sku)) ?? 0) > 0,
					active: doc.active,
				};
			}),
		);
	}

	async listVariants(productId: ProductId): Promise<ProductVariantSummary[]> {
		const doc = await this.#products.get(productId);
		if (doc === null) return [];
		const variants = Object.values(normalizeProductDoc(doc).variants).toSorted((a, b) =>
			codeUnitAsc(a.variantKey, b.variantKey),
		);
		const stock = this.#stockReader();
		return Promise.all(
			variants.map(async (variant) =>
				toVariantSummary(
					productId,
					variant,
					variant.sku === null ? null : await stock(variant.sku),
				),
			),
		);
	}

	async countByTaxClass(taxClassId: string): Promise<number> {
		return this.#products.count({ lifecycle: "live", taxClass: taxClassId });
	}

	// -- the admin list --------------------------------------------------------

	async listProducts(filter: ProductListFilter, page: ProductListPage): Promise<ProductListResult> {
		assertValidLowStockThreshold(filter);
		const cursor = page.cursor ?? null;
		// `limit + 1` is the port's own next-page probe: one row past the page decides
		// whether `nextCursor` is a position or null.
		const wanted = page.limit + 1;
		const stock = this.#stockReader();
		const keep = async (doc: ProductCommerceDoc): Promise<boolean> =>
			isAfterCursor(doc, cursor) && (await matchesInMemory(doc, filter, stock));

		const scanned = await this.#scanProducts(
			"listProducts",
			productListWhere(filter, cursor),
			{ createdAt: "desc" },
			wanted,
			keep,
		);
		// Sorted in CODE-UNIT order here, which is the adapter's total order; the scan
		// drained past its boundary tie group, so this slice cannot drop a tied row the
		// host's collation happened to order differently.
		const merged = scanned.toSorted(byNewestFirst).slice(0, wanted);
		const returned = merged.length > page.limit ? merged.slice(0, page.limit) : merged;
		const last = returned.at(-1);
		const nextCursor =
			merged.length > page.limit && last !== undefined
				? { createdAt: last.createdAt, productId: last.productId }
				: null;
		const products = await Promise.all(
			returned.map(async (doc) =>
				toProductSummary(doc, doc.sku === null ? null : await stock(doc.sku)),
			),
		);
		return { products, nextCursor };
	}

	/**
	 * The count that captions the page — the SAME predicate, by construction.
	 *
	 * When every axis of the filter is indexable it is ONE `count()`. When the
	 * filter carries a `search` or a `lowStockThreshold` — the two axes the filter
	 * algebra cannot express — the count resolves the whole matching set and
	 * counts it, because a cardinality over a predicate the store cannot push down
	 * has no cheaper honest answer. The indexed axes still narrow what is scanned.
	 */
	async countProducts(filter: ProductListFilter): Promise<number> {
		assertValidLowStockThreshold(filter);
		const where = productListWhere(filter, null);
		if (filter.search === undefined && filter.lowStockThreshold === undefined) {
			return this.#products.count(where);
		}
		const stock = this.#stockReader();
		const matched = await this.#scanProducts(
			"countProducts",
			where,
			{ createdAt: "desc" },
			Number.POSITIVE_INFINITY,
			(doc) => matchesInMemory(doc, filter, stock),
		);
		return matched.length;
	}

	/**
	 * Page the `product_commerce` index under one where clause, keeping the
	 * documents `keep` accepts, until `need` of them are collected or the pages run
	 * out.
	 *
	 * The host's own cursor drives the paging INSIDE one call, which is safe here
	 * for the reason it is not safe across calls: the row it re-reads to seek is a
	 * row this same call just read. Across calls the port's value-position cursor
	 * is used instead.
	 *
	 * Reaching the budget with pages unread and rows still owed is a typed
	 * {@link ScanPageLimitError}, never a silently short list.
	 */
	async #scanProducts(
		operation: string,
		where: WhereClause,
		orderBy: OrderBy,
		need: number,
		keep: (doc: ProductCommerceDoc) => Promise<boolean>,
	): Promise<ProductCommerceDoc[]> {
		const collected: ProductCommerceDoc[] = [];
		// The `createdAt` of the row that reached `need`. Once set, the scan keeps
		// draining until the FIRST row with a different `createdAt`: the ordering is on
		// `createdAt` alone, so stopping at `need` would make the page boundary depend
		// on the host's collation for `productId`.
		let boundary: string | null = null;
		let cursor: string | undefined;
		for (let page = 0; page < this.#maxListPages; page++) {
			const result = await this.#products.query({ where, orderBy, limit: LIST_PAGE_SIZE, cursor });
			for (const { data } of result.items) {
				const doc = normalizeProductDoc(data);
				if (boundary !== null && doc.createdAt !== boundary) return collected;
				if (!(await keep(doc))) continue;
				collected.push(doc);
				if (boundary === null && collected.length >= need) boundary = doc.createdAt;
			}
			if (!result.hasMore || result.cursor === undefined) return collected;
			cursor = result.cursor;
		}
		throw new ScanPageLimitError(operation, this.#maxListPages, collected.length, "maxListPages");
	}

	/**
	 * One memoized `inventory` read per sku per call.
	 *
	 * `null` is "no inventory document for this sku" and `0` is "a document holding
	 * nothing" — the port keeps them apart on every projection, and collapsing them
	 * would invent an out-of-stock claim (or hide one).
	 */
	#stockReader(): (sku: string) => Promise<number | null> {
		const seen = new Map<string, Promise<number | null>>();
		return (sku) => {
			const cached = seen.get(sku);
			if (cached !== undefined) return cached;
			const read = this.#inventory.get(sku).then((doc) => (doc === null ? null : doc.onHand));
			seen.set(sku, read);
			return read;
		};
	}

	// -- upsert: the CMS-sync / integrator channel -----------------------------

	/**
	 * Insert-or-update by product id, idempotent under `key` and order-aware under
	 * `contentUpdatedAt` — the SQL adapter's two `DO UPDATE … WHERE` guards, read
	 * off the same document the write commits against.
	 *
	 * THE SKU-RENAME RULE binds this writer exactly as it binds the guarded editor,
	 * because it is a property of the `sku` column: a write that CHANGES the row's
	 * sku takes the new sku's claim, carries the stock, and releases the old claim.
	 * A write that changes nothing, applies nothing, or sets the FIRST sku on a row
	 * that had none carries nothing — the carry follows the ROW's before/after sku,
	 * never the input's.
	 */
	async upsert(input: UpsertProductCommerceInput, key: IdempotencyKey): Promise<ProductCommerce> {
		if (typeof input.productId !== "string" || input.productId.length === 0) {
			throw new MissingProductIdError();
		}
		const ref: SkuOwnerRef = { kind: "product", productId: input.productId };
		return this.#cas("upsertProduct", async () => {
			const current = await this.#products.getVersioned(input.productId);
			const doc = current === null ? null : normalizeProductDoc(current.value);
			const now = this.#clock.now().toISOString();

			if (doc !== null && hasProductRow(doc)) {
				// Replay with the stored key: a provable no-op.
				if (doc.idempotencyKey === key) return casDone(toProductCommerce(doc));
				// A strictly older content watermark is a delayed/re-ordered delivery; it
				// never overwrites fresher data.
				if (
					input.contentUpdatedAt !== undefined &&
					doc.contentUpdatedAt !== null &&
					input.contentUpdatedAt < doc.contentUpdatedAt
				) {
					return casDone(toProductCommerce(doc));
				}
				// Only an APPLYING write takes a sku or moves stock: every no-op above
				// returned already, which is the position the SQL adapter's skipped
				// `DO UPDATE` occupies by construction.
				const take = await this.#takeSku(ref, doc.sku, input.sku, key);
				const next: ProductCommerceDoc = {
					...doc,
					sku: input.sku ?? doc.sku,
					price: input.price ?? doc.price,
					title: input.title !== undefined ? input.title : doc.title,
					taxClass: input.taxClass !== undefined ? input.taxClass : doc.taxClass,
					weightGrams: input.weightGrams !== undefined ? input.weightGrams : doc.weightGrams,
					lengthMm: input.lengthMm !== undefined ? input.lengthMm : doc.lengthMm,
					widthMm: input.widthMm !== undefined ? input.widthMm : doc.widthMm,
					heightMm: input.heightMm !== undefined ? input.heightMm : doc.heightMm,
					productKind: input.productKind ?? doc.productKind,
					idempotencyKey: key,
					contentUpdatedAt: input.contentUpdatedAt ?? doc.contentUpdatedAt,
					updatedAt: now,
				};
				if (current === null) throw new Error("unreachable: a read row has a revision");
				const written = await this.#products.compareAndSet(input.productId, current.revision, next);
				if (!written.applied) return CAS_RETRY;
				await this.#releaseTakeover(take, ref);
				return casDone(toProductCommerce(next));
			}

			// No product row yet — either no document at all, or a shell a variant
			// created. Both are a CREATE, and neither has a prior sku to move from.
			const take = await this.#takeSku(ref, null, input.sku, key);
			const base = doc ?? newShellProductDoc(input.productId, now);
			const created: ProductCommerceDoc = {
				...base,
				lifecycle: "live",
				sku: input.sku ?? null,
				price: input.price ?? null,
				title: input.title ?? null,
				taxClass: input.taxClass ?? null,
				// compare-at / cost / inventory-policy are EDIT-ONLY: a fresh row starts at
				// their defaults, and a later upsert preserves them (they are not on the
				// sync input at all).
				compareAtPrice: null,
				unitCost: null,
				inventoryPolicy: "deny",
				weightGrams: input.weightGrams ?? null,
				lengthMm: input.lengthMm ?? null,
				widthMm: input.widthMm ?? null,
				heightMm: input.heightMm ?? null,
				productKind: input.productKind ?? "physical",
				active: false,
				publishKey: "inactive",
				deletedAt: null,
				idempotencyKey: key,
				contentUpdatedAt: input.contentUpdatedAt ?? null,
				activeUpdatedAt: null,
				createdAt: now,
				updatedAt: now,
			};
			const written = await this.#products.compareAndSet(
				input.productId,
				current?.revision ?? null,
				created,
			);
			if (!written.applied) return CAS_RETRY;
			await this.#releaseTakeover(take, ref);
			return casDone(toProductCommerce(created));
		});
	}

	// -- the guarded admin edit ------------------------------------------------

	/**
	 * The optimistic compare-and-set edit, with the port's zero-row classifier in
	 * the order it pins: not_found → same-key replay `ok` → `stale` → the three
	 * currency mismatches → apply.
	 *
	 * The `expectedUpdatedAt` comparison is the port's guard and stays exactly
	 * that: raw ISO text, lexical = chronological. The document's own revision is a
	 * second, cheaper staleness check that only ever causes a RETRY — it can never
	 * turn an applying edit into a `stale` answer, because the classifier is
	 * re-derived from the freshly read document on every attempt.
	 */
	async updateCommerceFields(
		input: UpdateProductCommerceFieldsInput,
		key: IdempotencyKey,
		expectedUpdatedAt: string,
	): Promise<ProductCommerceUpdateResult> {
		const ref: SkuOwnerRef = { kind: "product", productId: input.productId };
		return this.#cas("updateCommerceFields", async () => {
			const current = await this.#products.getVersioned(input.productId);
			const doc = current === null ? null : normalizeProductDoc(current.value);

			// 1. An edit is not a create: unknown or tombstoned is not_found, AHEAD of
			//    the replay check, so a same-key replay arriving after a soft delete
			//    reports not_found rather than a spurious ok over a tombstone.
			if (doc === null || doc.lifecycle !== "live") {
				return casDone<ProductCommerceUpdateResult>({ ok: false, reason: "not_found" });
			}
			if (current === null) throw new Error("unreachable: a read row has a revision");
			// 2. Replay precedence over the CAS, so a double-submitted rename moves the
			//    units exactly once.
			if (doc.idempotencyKey === key) {
				return casDone<ProductCommerceUpdateResult>({ ok: true, product: toProductCommerce(doc) });
			}
			// 3. The port's lost-update guard.
			if (doc.updatedAt !== expectedUpdatedAt) {
				return casDone<ProductCommerceUpdateResult>({
					ok: false,
					reason: "stale",
					current: toProductCommerce(doc),
				});
			}
			// 4. Currency integrity, on all three sub-axes.
			const mismatch = productCurrencyMismatch(doc, input);
			if (mismatch) {
				return casDone<ProductCommerceUpdateResult>({
					ok: false,
					reason: "currency_mismatch",
					current: toProductCommerce(doc),
				});
			}

			// 5. Apply.
			const take = await this.#takeSku(ref, doc.sku, input.sku, key);
			const next: ProductCommerceDoc = {
				...doc,
				sku: input.sku ?? doc.sku,
				price: input.price ?? doc.price,
				// `title` is ABSENT from this input by design (ADR-0013): the CMS sync is
				// its sole writer, so an edit always preserves it.
				taxClass: input.taxClass !== undefined ? input.taxClass : doc.taxClass,
				compareAtPrice:
					input.compareAtPrice !== undefined ? input.compareAtPrice : doc.compareAtPrice,
				unitCost: input.unitCost !== undefined ? input.unitCost : doc.unitCost,
				inventoryPolicy:
					input.inventoryPolicy !== undefined ? input.inventoryPolicy : doc.inventoryPolicy,
				weightGrams: input.weightGrams !== undefined ? input.weightGrams : doc.weightGrams,
				lengthMm: input.lengthMm !== undefined ? input.lengthMm : doc.lengthMm,
				widthMm: input.widthMm !== undefined ? input.widthMm : doc.widthMm,
				heightMm: input.heightMm !== undefined ? input.heightMm : doc.heightMm,
				productKind: input.productKind ?? doc.productKind,
				idempotencyKey: key,
				updatedAt: this.#clock.now().toISOString(),
			};
			const written = await this.#products.compareAndSet(input.productId, current.revision, next);
			if (!written.applied) return CAS_RETRY;
			await this.#releaseTakeover(take, ref);
			return casDone<ProductCommerceUpdateResult>({ ok: true, product: toProductCommerce(next) });
		});
	}

	// -- the publish gate and the tombstone ------------------------------------

	/** The afterPublish→activate follow-up; see {@link EmdashProductCommerceStore.deactivate}. */
	async activate(
		productId: ProductId,
		key: IdempotencyKey,
		contentUpdatedAt: string,
	): Promise<void> {
		await this.#flipPublishGate("activate", productId, key, contentUpdatedAt, true);
	}

	/** The afterUnpublish→deactivate mirror. Flips ONLY the gate; never the tombstone. */
	async deactivate(
		productId: ProductId,
		key: IdempotencyKey,
		contentUpdatedAt: string,
	): Promise<void> {
		await this.#flipPublishGate("deactivate", productId, key, contentUpdatedAt, false);
	}

	/**
	 * The shared publish-gate flip. Unknown, tombstoned and already-in-that-state
	 * documents are stable no-ops, and a STALE watermark is a no-op so out-of-order
	 * lifecycle delivery converges.
	 *
	 * The watermark is the DEDICATED `activeUpdatedAt`, never the sync watermark: a
	 * plain content save advances that one without being a lifecycle event, so
	 * sharing it would let a save poison the gate. "Stale" is the applied watermark
	 * being STRICTLY newer than this one — an absent watermark never blocks, so the
	 * first transition always wins.
	 */
	async #flipPublishGate(
		operation: string,
		productId: ProductId,
		key: IdempotencyKey,
		contentUpdatedAt: string,
		active: boolean,
	): Promise<void> {
		await this.#cas<void>(operation, async () => {
			const current = await this.#products.getVersioned(productId);
			if (current === null) return casDone(undefined);
			const doc = normalizeProductDoc(current.value);
			// Unknown row, tombstone (a publish must never resurrect one), already in
			// this state, or a re-ordered older lifecycle event.
			if (doc.lifecycle !== "live") return casDone(undefined);
			if (doc.active === active) return casDone(undefined);
			if (doc.activeUpdatedAt !== null && doc.activeUpdatedAt > contentUpdatedAt) {
				return casDone(undefined);
			}
			const written = await this.#products.compareAndSet(productId, current.revision, {
				...doc,
				active,
				publishKey: publishKeyFor(active),
				activeUpdatedAt: contentUpdatedAt,
				idempotencyKey: key,
				updatedAt: this.#clock.now().toISOString(),
			});
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
	}

	/**
	 * Soft delete: the tombstone plus `active = false`, the row retained.
	 *
	 * It also RELEASES the row's sku claim, which is what makes the freeing
	 * explicit here where SQL got it as a side effect of a partial index predicate:
	 * live-sku uniqueness held among non-deleted rows only, so a tombstoned row's
	 * sku was reusable at once, and the claim document has to say so out loud.
	 */
	async softDelete(productId: ProductId, key: IdempotencyKey): Promise<void> {
		const ref: SkuOwnerRef = { kind: "product", productId };
		await this.#cas<void>("softDelete", async () => {
			const current = await this.#products.getVersioned(productId);
			if (current === null) return casDone(undefined);
			const doc = normalizeProductDoc(current.value);
			if (doc.lifecycle !== "live") return casDone(undefined);
			const at = this.#clock.now().toISOString();
			const written = await this.#products.compareAndSet(productId, current.revision, {
				...doc,
				lifecycle: "deleted",
				active: false,
				publishKey: "inactive",
				deletedAt: at,
				idempotencyKey: key,
				updatedAt: at,
			});
			if (!written.applied) return CAS_RETRY;
			if (doc.sku !== null) await this.#releaseSku(doc.sku, ref);
			return casDone(undefined);
		});
	}

	// -- variants --------------------------------------------------------------

	/**
	 * The CMS-sync channel for one variant: declare-or-update by
	 * `(productId, variantKey)`, idempotent under `key`, order-aware under
	 * `contentUpdatedAt`, and the RESURRECT half of the presence axis.
	 *
	 * It NEVER refuses presence and never throws a constraint error — a declare
	 * states a fact about the CMS, and the commerce database does not get a vote.
	 * So a resurrect REVALIDATES the stale commerce facts on the way back in: the
	 * sku is kept only while it is still free among live sellable units, and the
	 * price only while its currency is still one the product can honour. The
	 * inventory document is never touched either way — a cleared sku leaves its
	 * stock exactly where it is, and re-assigning it later ADOPTS that document
	 * under THE FIRST-SKU ASYMMETRY.
	 *
	 * Presence moves only on a delivery that CARRIES a watermark and is STRICTLY
	 * newer than the stored one, which is narrower than the title's own
	 * last-writer-wins guard: that is what makes a redelivered declare unable to
	 * resurrect a variant a newer save has since dropped.
	 *
	 * No parent-row check: a variant may land before its product row, and this
	 * writer creates the document as a shell when it does.
	 */
	async upsertVariant(
		input: UpsertProductVariantInput,
		key: IdempotencyKey,
	): Promise<ProductVariant> {
		if (typeof input.productId !== "string" || input.productId.length === 0) {
			throw new MissingProductIdError();
		}
		if (typeof input.variantKey !== "string" || input.variantKey.length === 0) {
			throw new MissingVariantKeyError();
		}
		const ref: SkuOwnerRef = {
			kind: "variant",
			productId: input.productId,
			variantKey: input.variantKey,
		};
		return this.#cas("upsertVariant", async () => {
			const current = await this.#products.getVersioned(input.productId);
			const now = this.#clock.now().toISOString();
			const doc =
				current === null
					? newShellProductDoc(input.productId, now)
					: normalizeProductDoc(current.value);
			const existing = doc.variants[input.variantKey];

			if (existing === undefined) {
				const created = newVariantDoc(
					input.variantKey,
					input.title ?? null,
					key,
					input.contentUpdatedAt ?? null,
					now,
				);
				const written = await this.#products.compareAndSet(
					input.productId,
					current?.revision ?? null,
					{ ...doc, variants: { ...doc.variants, [input.variantKey]: created } },
				);
				if (!written.applied) return CAS_RETRY;
				return casDone(toProductVariant(input.productId, created));
			}
			if (current === null) throw new Error("unreachable: a read row has a revision");

			// Replay with the stored key: a provable no-op.
			if (existing.idempotencyKey === key) {
				return casDone(toProductVariant(input.productId, existing));
			}
			// A strictly older content revision never overwrites fresher data.
			if (
				input.contentUpdatedAt !== undefined &&
				existing.contentUpdatedAt !== null &&
				input.contentUpdatedAt < existing.contentUpdatedAt
			) {
				return casDone(toProductVariant(input.productId, existing));
			}

			const resurrecting =
				existing.orphanedAt !== null &&
				input.contentUpdatedAt !== undefined &&
				(existing.contentUpdatedAt === null || input.contentUpdatedAt > existing.contentUpdatedAt);
			let sku = existing.sku;
			let price = existing.price;
			if (resurrecting) {
				if (sku !== null && !(await this.#reclaimSku(sku, ref))) {
					// An orphan cannot reclaim what was legitimately reused while it was
					// gone. This is the ONE case where a sku goes back to null: the row is
					// not being edited, it is losing a claim it no longer has.
					sku = null;
				}
				if (price !== null) {
					const productCurrency = resolveProductCurrency(doc, input.variantKey);
					if (productCurrency !== null && productCurrency !== price.currency) price = null;
				}
			}
			const updated: ProductVariantDoc = {
				...existing,
				title: input.title !== undefined ? input.title : existing.title,
				sku,
				price,
				orphanedAt: resurrecting ? null : existing.orphanedAt,
				idempotencyKey: key,
				contentUpdatedAt: input.contentUpdatedAt ?? existing.contentUpdatedAt,
				updatedAt: now,
			};
			const written = await this.#products.compareAndSet(input.productId, current.revision, {
				...doc,
				variants: { ...doc.variants, [input.variantKey]: updated },
			});
			if (!written.applied) return CAS_RETRY;
			return casDone(toProductVariant(input.productId, updated));
		});
	}

	/**
	 * The guarded admin edit at variant grain — the exact mirror of
	 * `updateCommerceFields`, including its classifier order: not_found (unknown or
	 * ORPHANED — an edit is neither a create nor a resurrection) → same-key replay
	 * `ok` → `stale` → currency on both sub-axes → apply under THE SKU-RENAME RULE.
	 *
	 * The product's currency is resolved from the SAME document this write commits
	 * against, which is what retires the SQL adapter's parent-row lock: two sizes
	 * first-priced at once in different currencies contend for one revision, so the
	 * loser re-reads, sees the winner's currency, and is refused.
	 */
	async updateVariantFields(
		input: UpdateProductVariantFieldsInput,
		key: IdempotencyKey,
		expectedUpdatedAt: string,
	): Promise<ProductVariantUpdateResult> {
		const ref: SkuOwnerRef = {
			kind: "variant",
			productId: input.productId,
			variantKey: input.variantKey,
		};
		return this.#cas("updateVariantFields", async () => {
			const current = await this.#products.getVersioned(input.productId);
			const doc = current === null ? null : normalizeProductDoc(current.value);
			const existing = doc?.variants[input.variantKey];
			if (doc === null || existing === undefined || existing.orphanedAt !== null) {
				return casDone<ProductVariantUpdateResult>({ ok: false, reason: "not_found" });
			}
			if (current === null) throw new Error("unreachable: a read row has a revision");
			if (existing.idempotencyKey === key) {
				return casDone<ProductVariantUpdateResult>({
					ok: true,
					variant: toProductVariant(input.productId, existing),
				});
			}
			if (existing.updatedAt !== expectedUpdatedAt) {
				return casDone<ProductVariantUpdateResult>({
					ok: false,
					reason: "stale",
					current: toProductVariant(input.productId, existing),
				});
			}
			if (input.price !== undefined) {
				// a. never switch this variant's own currency; b. never disagree with the
				// product's — its own price currency, else a live sibling's.
				const own = existing.price;
				const productCurrency = resolveProductCurrency(doc, input.variantKey);
				if (
					(own !== null && own.currency !== input.price.currency) ||
					(productCurrency !== null && productCurrency !== input.price.currency)
				) {
					return casDone<ProductVariantUpdateResult>({
						ok: false,
						reason: "currency_mismatch",
						current: toProductVariant(input.productId, existing),
					});
				}
			}

			const take = await this.#takeSku(ref, existing.sku, input.sku, key);
			const updated: ProductVariantDoc = {
				...existing,
				sku: input.sku ?? existing.sku,
				price: input.price ?? existing.price,
				idempotencyKey: key,
				updatedAt: this.#clock.now().toISOString(),
			};
			const written = await this.#products.compareAndSet(input.productId, current.revision, {
				...doc,
				variants: { ...doc.variants, [input.variantKey]: updated },
			});
			if (!written.applied) return CAS_RETRY;
			await this.#releaseTakeover(take, ref);
			return casDone<ProductVariantUpdateResult>({
				ok: true,
				variant: toProductVariant(input.productId, updated),
			});
		});
	}

	/**
	 * The ORPHAN transition: deactivation, never deletion. The row keeps its sku,
	 * its price and its inventory, because an orphan may still hold stock and still
	 * sit on live order lines.
	 *
	 * A same-key replay is a no-op AHEAD of every other guard, exactly as the two
	 * write paths dedupe — without it a redelivered orphan whose row has since come
	 * back would apply a second time. The watermark comparison is `<=` rather than
	 * the resurrect's strict `<`: one save legitimately declares some keys and drops
	 * others at the SAME watermark.
	 *
	 * The orphaned variant's sku claim is RELEASED, which is the claim document's
	 * statement of the partial index's `WHERE orphaned_at IS NULL`.
	 */
	async deactivateVariant(
		productId: ProductId,
		variantKey: string,
		key: IdempotencyKey,
		contentUpdatedAt: string,
	): Promise<void> {
		const ref: SkuOwnerRef = { kind: "variant", productId, variantKey };
		await this.#cas<void>("deactivateVariant", async () => {
			const current = await this.#products.getVersioned(productId);
			if (current === null) return casDone(undefined);
			const doc = normalizeProductDoc(current.value);
			const existing = doc.variants[variantKey];
			if (existing === undefined) return casDone(undefined);
			if (existing.idempotencyKey === key) return casDone(undefined);
			if (existing.orphanedAt !== null) return casDone(undefined);
			if (existing.contentUpdatedAt !== null && existing.contentUpdatedAt > contentUpdatedAt) {
				return casDone(undefined);
			}
			const at = this.#clock.now().toISOString();
			const written = await this.#products.compareAndSet(productId, current.revision, {
				...doc,
				variants: {
					...doc.variants,
					[variantKey]: {
						...existing,
						orphanedAt: at,
						idempotencyKey: key,
						contentUpdatedAt,
						updatedAt: at,
					},
				},
			});
			if (!written.applied) return CAS_RETRY;
			if (existing.sku !== null) await this.#releaseSku(existing.sku, ref);
			return casDone(undefined);
		});
	}

	// -- the sku axis ----------------------------------------------------------

	/**
	 * Take the sku an APPLYING write is asking for, and carry the stock if that is a
	 * rename. The order is the port's: the claim (`SkuConflictError`) is resolved
	 * BEFORE any inventory write, then the carry's own two refusals.
	 *
	 * A refusal from the carry ROLLS BACK a claim this call created, so a refused
	 * rename leaves the sku free for the next writer — the position SQL got for
	 * free from a transaction abort.
	 */
	async #takeSku(
		ref: SkuOwnerRef,
		currentSku: Sku | null,
		nextSku: Sku | undefined,
		commandKey: string,
	): Promise<SkuTakeover> {
		if (nextSku === undefined) return { releaseSku: null };
		const claim = await this.#claimSku(nextSku, ref);
		if (currentSku === null || currentSku === nextSku) return { releaseSku: null };
		try {
			await this.#transfer.carry(currentSku, nextSku, commandKey, claim.alreadyOurs);
		} catch (err) {
			if (claim.createdNow) await this.#releaseSku(nextSku, ref);
			throw err;
		}
		return { releaseSku: currentSku };
	}

	/** Release the source sku's claim once the write that moved off it has committed. */
	async #releaseTakeover(take: SkuTakeover, ref: SkuOwnerRef): Promise<void> {
		if (take.releaseSku !== null) await this.#releaseSku(take.releaseSku, ref);
	}

	/**
	 * Claim `sku` for `ref`, or refuse with `SkuConflictError`.
	 *
	 * Three outcomes, and the distinction between the last two is load-bearing for
	 * the carry (see {@link SkuStockTransfer.carry}'s `targetIsOurs`):
	 *  - no document ⇒ create-if-absent, which is a DB-level
	 *    `INSERT … ON CONFLICT DO NOTHING` and therefore race-safe;
	 *  - a RELEASED document (`live: false`) ⇒ taken over by compare-and-set on its
	 *    revision, which is how a sku freed by a soft delete or an orphaning is
	 *    reused;
	 *  - a LIVE document held by somebody else ⇒ `SkuConflictError`, the one refusal
	 *    that outranks both stock refusals;
	 *  - a LIVE document already held by `ref` ⇒ nothing to do, and the caller is
	 *    told it was already ours.
	 */
	#claimSku(sku: string, ref: SkuOwnerRef): Promise<SkuClaim> {
		return this.#cas<SkuClaim>("claimSku", async () => {
			const current = await this.#skuOwners.getVersioned(sku);
			const at = this.#clock.now().toISOString();
			if (current === null) {
				const written = await this.#skuOwners.compareAndSet(
					sku,
					null,
					newSkuOwnerDoc(sku, ref, at),
				);
				return written.applied
					? casDone<SkuClaim>({ alreadyOurs: false, createdNow: true })
					: CAS_RETRY;
			}
			if (current.value.live) {
				if (isOwnedBy(current.value, ref)) {
					return casDone<SkuClaim>({ alreadyOurs: true, createdNow: false });
				}
				throw new SkuConflictError(sku);
			}
			const written = await this.#skuOwners.compareAndSet(
				sku,
				current.revision,
				newSkuOwnerDoc(sku, ref, at),
			);
			return written.applied
				? casDone<SkuClaim>({ alreadyOurs: false, createdNow: true })
				: CAS_RETRY;
		});
	}

	/**
	 * Re-claim a sku for a RESURRECTING variant, reporting whether it is still
	 * available — never throwing, because a declare states a fact about the CMS and
	 * cannot be refused.
	 *
	 * False means another live sellable unit took the sku while this variant was
	 * orphaned, and the resurrect clears it.
	 */
	async #reclaimSku(sku: string, ref: SkuOwnerRef): Promise<boolean> {
		try {
			await this.#claimSku(sku, ref);
			return true;
		} catch (err) {
			if (err instanceof SkuConflictError) return false;
			throw err;
		}
	}

	/**
	 * Release `ref`'s claim on `sku` — a soft delete, an orphaning, a rename away,
	 * or the rollback of a refused rename.
	 *
	 * The document is RETAINED with `live: false` rather than deleted, so the next
	 * claimant takes it over in one guarded write instead of a delete-then-insert
	 * with a window in the middle. A claim that is not ours (somebody already took
	 * it over) is left alone.
	 */
	async #releaseSku(sku: string, ref: SkuOwnerRef): Promise<void> {
		await this.#cas<void>("releaseSku", async () => {
			const current = await this.#skuOwners.getVersioned(sku);
			if (current === null) return casDone(undefined);
			if (!current.value.live || !isOwnedBy(current.value, ref)) return casDone(undefined);
			const written = await this.#skuOwners.compareAndSet(sku, current.revision, {
				...current.value,
				live: false,
			});
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
	}

	#cas<T>(operation: string, step: (attempt: number) => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}
}

// -- predicates and projections ---------------------------------------------

/**
 * Validates `filter.lowStockThreshold` BEFORE any row is considered, via the
 * shared domain guard every adapter calls — so an empty store throws exactly like
 * a populated one, and a `NaN` threshold can never silently decide "nothing is
 * low stock".
 */
function assertValidLowStockThreshold(filter: ProductListFilter): void {
	if (
		filter.lowStockThreshold !== undefined &&
		!isValidLowStockThreshold(filter.lowStockThreshold)
	) {
		throw new InvalidLowStockThresholdError(filter.lowStockThreshold);
	}
}

/**
 * The pushed-down half of the list predicate, shared VERBATIM by `listProducts`
 * and `countProducts` — which is why a count can never disagree with the page it
 * captions.
 *
 * `lifecycle` carries the tombstone axis AND excludes a document that holds only
 * variants. The cursor contributes its coarse `createdAt` bound only; the exact
 * position is decided in memory, because `(createdAt, productId)` keyset
 * semantics need an OR the algebra does not have.
 */
function productListWhere(
	filter: ProductListFilter,
	cursor: { createdAt: string; productId: string } | null,
): WhereClause {
	const where: WhereClause = { lifecycle: filter.deleted === true ? "deleted" : "live" };
	if (filter.active !== undefined) where.publishKey = publishKeyFor(filter.active);
	if (filter.productKind !== undefined) where.productKind = filter.productKind;
	if (cursor !== null) where.createdAt = { lte: cursor.createdAt };
	return where;
}

/** Strictly after the cursor position under `createdAt DESC, productId DESC`. */
function isAfterCursor(
	doc: ProductCommerceDoc,
	cursor: { createdAt: string; productId: string } | null,
): boolean {
	if (cursor === null) return true;
	if (doc.createdAt > cursor.createdAt) return false;
	if (doc.createdAt < cursor.createdAt) return true;
	return doc.productId < cursor.productId;
}

/** `created_at DESC, product_id DESC`, in code-unit order — never a locale. */
function byNewestFirst(a: ProductCommerceDoc, b: ProductCommerceDoc): number {
	return a.createdAt === b.createdAt
		? codeUnitDesc(a.productId, b.productId)
		: codeUnitDesc(a.createdAt, b.createdAt);
}

/**
 * The two axes the filter algebra cannot express, applied to a document the
 * indexed axes already accepted.
 *
 * `search` is an OR: an EXACT case-insensitive sku match, or a case-insensitive
 * SUBSTRING of the title. A row whose sku or title is null simply cannot match
 * that half — never a throw — and the query string is compared as plain text, so
 * a `%` or `_` in it is a literal character rather than a wildcard.
 *
 * `lowStockThreshold` matches iff the sku resolves to a KNOWN inventory document
 * whose count is at or below the threshold, INCLUSIVE. Absent is not zero: a
 * product with no sku, or a sku with no document, is UNKNOWN stock and never
 * "low".
 */
async function matchesInMemory(
	doc: ProductCommerceDoc,
	filter: ProductListFilter,
	stock: (sku: string) => Promise<number | null>,
): Promise<boolean> {
	if (filter.search !== undefined) {
		const needle = filter.search.toLowerCase();
		const bySku = doc.sku !== null && doc.sku.toLowerCase() === needle;
		const byTitle = doc.title !== null && doc.title.toLowerCase().includes(needle);
		if (!bySku && !byTitle) return false;
	}
	if (filter.lowStockThreshold !== undefined) {
		const onHand = doc.sku === null ? null : await stock(doc.sku);
		if (onHand === null || onHand > filter.lowStockThreshold) return false;
	}
	return true;
}

/**
 * Guard 4 of the product edit, all three sub-axes, in the port's order.
 *
 *  a. a `price` whose currency differs from the STORED price's (a first pricing
 *     accepts any currency);
 *  b. a `compareAtPrice`/`unitCost` supplied WITHOUT a price in the same edit whose
 *     currency differs from the stored price currency — INCLUDING the not-priced-yet
 *     case, since compare-at and cost require something to match. When a price IS
 *     in the same edit, the within-edit currencies were checked upstream and (a)
 *     fixes the row currency, so they inherit it with no separate guard;
 *  c. a `price` whose currency differs from any LIVE VARIANT's — the reciprocal of
 *     the variant path's own guard, and resolved from the SAME document, so a
 *     product repricing and a variant pricing cannot both pass by reading each
 *     other's "before" state.
 */
function productCurrencyMismatch(
	doc: ProductCommerceDoc,
	input: UpdateProductCommerceFieldsInput,
): boolean {
	if (input.price !== undefined) {
		if (doc.price !== null && doc.price.currency !== input.price.currency) return true;
		const clash = liveVariants(doc).some(
			(variant) => variant.price !== null && variant.price.currency !== input.price?.currency,
		);
		if (clash) return true;
		return false;
	}
	const rowCurrency = doc.price?.currency ?? null;
	for (const extra of [input.compareAtPrice, input.unitCost]) {
		if (extra !== undefined && extra !== null && extra.currency !== rowCurrency) return true;
	}
	return false;
}
