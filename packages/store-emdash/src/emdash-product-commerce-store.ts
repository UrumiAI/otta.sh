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
	SkuHeldStockError,
	SkuStockConflictError,
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
	owesCarryFrom,
	PRODUCT_COMMERCE_COLLECTION,
	publishKeyFor,
	resolveProductCurrency,
	SKU_OWNERS_COLLECTION,
	toProductCommerce,
	toProductSummary,
	toProductVariant,
	toVariantSummary,
	type PendingRenameDoc,
	type ProductCommerceDoc,
	type ProductVariantDoc,
	type SkuOwnerDoc,
	type SkuOwnerRef,
} from "./product-commerce-documents.js";
import {
	SkuStockTransfer,
	skuTransferToken,
	type SkuRenameLedgerDoc,
} from "./sku-stock-transfer.js";
import type { OrderBy, StorageAccess, StorageCollection, WhereClause } from "./storage-access.js";

/** The host clamps `limit` at 100, so a scan pages at the ceiling. */
const LIST_PAGE_SIZE = 100;

/** Default page ceiling for a bounded scan. 1000 × 100 pointers. */
const MAX_LIST_PAGES = 1000;

/**
 * How many attempts a write spends waiting for a CONTENDED target claim before it
 * refuses.
 *
 * The contended state is "this owner won the sku's claim while the target had no
 * inventory document, and by the time the document was claimed one existed". Only two
 * writers can produce it: a second call renaming the SAME product onto the SAME sku,
 * which must not be refused a conflict the operator never created, and `seedOnHand`
 * slipping into a one-write window, which is a genuine occupancy the port refuses.
 * They are indistinguishable from the documents, so the write waits — the peer case
 * resolves within a round trip, because the peer commits its product document right
 * after claiming — and refuses if it does not.
 *
 * Small on purpose. Each attempt costs one jittered backoff from the shared retry
 * schedule, so the refusal an operator eventually sees is still prompt.
 */
const TARGET_CLAIM_CONTENTION_ATTEMPTS = 6;

/** A prepared sku axis, or a target claim contended by a peer of the same owner. */
const CONTENDED = "contended" as const;

/**
 * How old a live sku claim that nothing backs must be before another owner may take
 * it over.
 *
 * The claim document is written ONE round trip before the product document that will
 * hold the sku, so a process that dies in between leaves a live claim nothing
 * references — and, if the write was a rename, an empty inventory document under the
 * target. Both are durable, and neither `finally` nor a retry can reach them: the
 * process is gone. Without a way out, that sku is wedged for good, which is exactly
 * the "any replayer completes it" contract this design rests on.
 *
 * A lease is the way out, and the age is the only signal available: an in-flight
 * claim is milliseconds old, a dead one is not. A minute is far beyond the worst
 * legitimate case — the whole retry budget is `CAS_MAX_ATTEMPTS` attempts with sleeps
 * capped at `CAS_MAX_DELAY_MS`, well under two seconds — and short enough that a
 * merchant retrying a crashed rename is not told to come back tomorrow.
 *
 * It is NOT a general unlock. A claim whose owner holds the sku, and a claim whose
 * owner still OWES a stock carry away from it, are never taken over at any age.
 */
const CLAIM_ABANDON_AFTER_MS = 60_000;

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
	/**
	 * Override the sku-claim lease, in milliseconds. Defaults to
	 * {@link CLAIM_ABANDON_AFTER_MS}; see that constant for why 60 s, and lower it only
	 * where the whole retry budget is known to be shorter.
	 */
	claimAbandonAfterMs?: number;
}

/**
 * What the sku axis of ONE applying write decided, before it commits.
 *
 * The carry is deliberately NOT run yet: it runs after the product document's
 * compare-and-set wins, and this is what that write records as its intent. See
 * {@link PendingRenameDoc}.
 */
interface SkuPreparation {
	/** The carry to record and then run, or null when this write moves no stock. */
	readonly carry: PendingRenameDoc | null;
	/** The source sku's claim to release once the write has committed. */
	readonly releaseSku: string | null;
	/**
	 * The sku claim this write is standing on, to be RE-ASSERTED immediately before the
	 * product document commits. Null when the write took no claim.
	 */
	readonly hold: SkuHold | null;
}

/**
 * A sku claim this call holds, and the revision it last saw it at.
 *
 * The revision is what turns "we claimed it earlier" into a checkable fact at commit
 * time: a compare-and-set at that revision both proves the claim is still ours and
 * re-stamps its lease. See {@link EmdashProductCommerceStore.#heartbeatClaim}.
 */
interface SkuHold {
	readonly sku: string;
	revision: string;
	/** Carried so the heartbeat rewrites the claim without losing what it recorded. */
	readonly createsTarget: boolean;
}

/**
 * The claims one CALL has taken, so a call that never commits can give them back.
 *
 * It lives outside the retry loop on purpose: releasing a claim between attempts
 * would let a peer take the sku and turn the next attempt's honest rename into a
 * spurious refusal, so the undo happens once, at the end, and only if nothing
 * committed.
 */
interface SkuClaimLedger {
	/** A `sku_owners` claim this call created or took over. */
	claimed: string | null;
	/** A target inventory document this call created. */
	createdTarget: string | null;
	/** Set by the applying branch; suppresses the undo. */
	committed: boolean;
	/** How many attempts have found the target's claim contended by a peer. */
	contended: number;
}

/**
 * What a LIVE claim held by somebody else actually means.
 *
 *  - `"held"` — the owner's live product row (or non-orphaned variant) carries this
 *    sku. The refusal is a statement of fact.
 *  - `"owed"` — the owner no longer carries the sku but still OWES a stock carry away
 *    from it: its units are mid-move and belong to that carry. Never taken over, at
 *    any age.
 *  - `"in-flight"` — nothing backs it and it is younger than the lease: a writer one
 *    round trip from committing the document that will back it.
 *  - `"abandoned"` — nothing backs it, nothing owes it, and it is older than the
 *    lease. The writer that took it is gone; the claim may be taken over.
 */
type ClaimStatus = "held" | "owed" | "in-flight" | "abandoned";

/** One resolved sku claim: whether it was already ours, and what it found. */
interface SkuClaim {
	/** The claim was ALREADY live and ours before this call touched it. */
	readonly alreadyOurs: boolean;
	/** This call created the claim (or took over a released one) and owns the rollback. */
	readonly createdNow: boolean;
	/**
	 * The target sku already had an inventory document at the moment this owner won
	 * its claim — so those units belong to nobody living, and "occupied is occupied"
	 * applies at once rather than being contended with a peer. Always false when there
	 * is no stock question to ask (a first sku assignment).
	 */
	readonly occupiedAtClaim: boolean;
	/**
	 * Whether THIS write is the one that creates the sku's inventory document — the
	 * single source for {@link SkuOwnerDoc.createsTarget}, derived once inside
	 * `#claimSku` from its own occupancy read rather than re-derived by the caller.
	 */
	readonly createsTarget: boolean;
	/** The claim document's revision as this call last saw it. */
	readonly revision: string;
}

export class EmdashProductCommerceStore implements ProductCommerceStore {
	readonly #products: StorageCollection<ProductCommerceDoc>;
	readonly #skuOwners: StorageCollection<SkuOwnerDoc>;
	readonly #inventory: StorageCollection<InventoryDoc>;
	readonly #transfer: SkuStockTransfer;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;
	readonly #maxListPages: number;
	readonly #claimAbandonAfterMs: number;

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
		this.#claimAbandonAfterMs = options.claimAbandonAfterMs ?? CLAIM_ABANDON_AFTER_MS;
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

	/**
	 * Finish every stock carry `product_commerce/{productId}` still records — the
	 * sweeper's entry point for the coupling the port cannot make atomic, and the
	 * same completion the next ordinary write on this product would perform.
	 *
	 * Returns how many recorded carries it was able to finish. A carry whose source
	 * still has a live hold cannot move yet: it keeps its record, the units stay on
	 * the source, and it is counted as unfinished rather than reported as done.
	 *
	 * Idempotent, and safe to run concurrently with itself and with a write: the
	 * move's own token guards the target's credit and the source's clear, so a second
	 * run moves nothing.
	 */
	async completeRecordedRenames(productId: ProductId): Promise<number> {
		const doc = await this.#products.get(productId);
		if (doc === null) return 0;
		const normalized = normalizeProductDoc(doc);
		let finished = 0;
		const settle = async (
			records: Record<string, PendingRenameDoc> | undefined,
			ref: SkuOwnerRef,
			clear: (token: string) => Promise<void>,
		): Promise<void> => {
			await this.#settleRecorded(records, ref, async (token) => {
				finished++;
				await clear(token);
			});
		};
		await settle(normalized.pendingRenames, { kind: "product", productId }, (token) =>
			this.#clearProductStamp(productId, token),
		);
		for (const variant of Object.values(normalized.variants)) {
			await settle(
				variant.pendingRenames,
				{ kind: "variant", productId, variantKey: variant.variantKey },
				(token) => this.#clearVariantStamp(productId, variant.variantKey, token),
			);
		}
		return finished;
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
		const result = new Map<ProductId, ProductCommerce>();
		for (const doc of await this.#readBatch(productIds)) {
			if (!hasProductRow(doc)) continue;
			result.set(doc.productId, toProductCommerce(doc));
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
		// Narrowed by a LOOP rather than by `filter`, so the compiler carries the guard
		// through: a predicate-filtered array forgets that `sku` and `price` are non-null
		// and the code would need a cast to say what the guard already proved.
		const sellable: Omit<ProductCommerceView, "inStock">[] = [];
		for (const doc of await this.#readBatch(productIds)) {
			if (doc.lifecycle !== "live") continue;
			const { sku, price } = doc;
			if (sku === null || price === null) continue;
			sellable.push({ productId: doc.productId, sku, price, active: doc.active });
		}
		const stock = this.#stockReader();
		return Promise.all(
			sellable.map(async (row) => ({
				...row,
				// A missing document (`null`) is coarsely "not in stock", exactly like 0.
				inStock: ((await stock(row.sku)) ?? 0) > 0,
			})),
		);
	}

	/**
	 * One batch of product documents, read with `productId in [...]` rather than a
	 * `get` per id — the anti-N+1 shape both batch methods exist for.
	 *
	 * Chunked at the host's `limit` ceiling of 100, so a batch of N ids is
	 * `ceil(N / 100)` statements and the common case is ONE. Missing ids are simply
	 * absent (never a null entry, never an error) and duplicates collapse, because a
	 * document matches a value set once. No ordering is requested: the port
	 * guarantees none and says to look results up by id.
	 */
	async #readBatch(productIds: readonly ProductId[]): Promise<ProductCommerceDoc[]> {
		const unique = [...new Set(productIds)];
		if (unique.length === 0) return [];
		const docs: ProductCommerceDoc[] = [];
		for (let start = 0; start < unique.length; start += LIST_PAGE_SIZE) {
			const chunk = unique.slice(start, start + LIST_PAGE_SIZE);
			let cursor: string | undefined;
			do {
				const result = await this.#products.query({
					where: { productId: { in: [...chunk] } },
					limit: LIST_PAGE_SIZE,
					cursor,
				});
				for (const { data } of result.items) docs.push(normalizeProductDoc(data));
				cursor = result.hasMore ? result.cursor : undefined;
			} while (cursor !== undefined);
		}
		return docs;
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
		const ledger: SkuClaimLedger = {
			claimed: null,
			createdTarget: null,
			committed: false,
			contended: 0,
		};
		try {
			return await this.#upsertApplying(input, key, ref, ledger);
		} finally {
			if (!ledger.committed) await this.#undoClaims(ledger, ref);
		}
	}

	#upsertApplying(
		input: UpsertProductCommerceInput,
		key: IdempotencyKey,
		ref: SkuOwnerRef,
		ledger: SkuClaimLedger,
	): Promise<ProductCommerce> {
		const clearStamp = (token: string): Promise<void> =>
			this.#clearProductStamp(input.productId, token);
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
				// Carries an earlier write recorded but did not finish are completed before
				// this one moves the same skus; see `#settleRecorded`.
				const owed = await this.#settleRecorded(doc.pendingRenames, ref, clearStamp);
				EmdashProductCommerceStore.#refuseWhileOwed(owed, doc.sku, input.sku);
				const prepared = await this.#prepareSku(ledger, ref, doc.sku, input.sku, key);
				if (prepared === CONTENDED) return CAS_RETRY;
				const next: ProductCommerceDoc = {
					...doc,
					pendingRenames: EmdashProductCommerceStore.#withRecord(
						doc.pendingRenames,
						prepared.carry,
					),
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
				// The claim is re-asserted HERE, adjacent to the commit, so a takeover that
				// happened while this call was in flight refuses it instead of letting two
				// live rows name one sku.
				if (prepared.hold !== null && !(await this.#heartbeatClaim(prepared.hold, ref, ledger))) {
					return CAS_RETRY;
				}
				const written = await this.#products.compareAndSet(input.productId, current.revision, next);
				if (!written.applied) return CAS_RETRY;
				ledger.committed = true;
				await this.#settleWrite(prepared, ref, clearStamp);
				return casDone(toProductCommerce(next));
			}

			// No product row yet — either no document at all, or a shell a variant
			// created. Both are a CREATE, and neither has a prior sku to move from.
			const prepared = await this.#prepareSku(ledger, ref, null, input.sku, key);
			if (prepared === CONTENDED) return CAS_RETRY;
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
			if (prepared.hold !== null && !(await this.#heartbeatClaim(prepared.hold, ref, ledger))) {
				return CAS_RETRY;
			}
			const written = await this.#products.compareAndSet(
				input.productId,
				current?.revision ?? null,
				created,
			);
			if (!written.applied) return CAS_RETRY;
			ledger.committed = true;
			await this.#settleWrite(prepared, ref, clearStamp);
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
		const ledger: SkuClaimLedger = {
			claimed: null,
			createdTarget: null,
			committed: false,
			contended: 0,
		};
		try {
			return await this.#editApplying(input, key, expectedUpdatedAt, ref, ledger);
		} finally {
			if (!ledger.committed) await this.#undoClaims(ledger, ref);
		}
	}

	#editApplying(
		input: UpdateProductCommerceFieldsInput,
		key: IdempotencyKey,
		expectedUpdatedAt: string,
		ref: SkuOwnerRef,
		ledger: SkuClaimLedger,
	): Promise<ProductCommerceUpdateResult> {
		const clearStamp = (token: string): Promise<void> =>
			this.#clearProductStamp(input.productId, token);
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
			const owed = await this.#settleRecorded(doc.pendingRenames, ref, clearStamp);
			EmdashProductCommerceStore.#refuseWhileOwed(owed, doc.sku, input.sku);
			const prepared = await this.#prepareSku(ledger, ref, doc.sku, input.sku, key);
			if (prepared === CONTENDED) return CAS_RETRY;
			const next: ProductCommerceDoc = {
				...doc,
				pendingRenames: EmdashProductCommerceStore.#withRecord(doc.pendingRenames, prepared.carry),
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
			if (prepared.hold !== null && !(await this.#heartbeatClaim(prepared.hold, ref, ledger))) {
				return CAS_RETRY;
			}
			const written = await this.#products.compareAndSet(input.productId, current.revision, next);
			if (!written.applied) return CAS_RETRY;
			ledger.committed = true;
			await this.#settleWrite(prepared, ref, clearStamp);
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
			let reclaimed: SkuHold | null = null;
			if (resurrecting) {
				if (sku !== null) reclaimed = await this.#reclaimSku(sku, ref);
				if (sku !== null && reclaimed === null) {
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
			// The re-assertion a resurrect owes, for the same reason every other sku-taking
			// write owes one: the claim was proven when it was taken and this commit is
			// later. A claim that has gone means the sku was reused inside the window, which
			// for THIS channel is not a refusal but a fact to revalidate — so the step
			// re-runs, `#reclaimSku` reports the sku unavailable, and the resurrect hands it
			// back as absent. The CMS channel still never fails.
			if (reclaimed !== null) {
				let held: boolean;
				try {
					held = await this.#heartbeatClaim(reclaimed, ref, {
						claimed: null,
						createdTarget: null,
						committed: false,
						contended: 0,
					});
				} catch (err) {
					if (!(err instanceof SkuConflictError)) throw err;
					return CAS_RETRY;
				}
				if (!held) return CAS_RETRY;
			}
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
		const ledger: SkuClaimLedger = {
			claimed: null,
			createdTarget: null,
			committed: false,
			contended: 0,
		};
		try {
			return await this.#variantEditApplying(input, key, expectedUpdatedAt, ref, ledger);
		} finally {
			if (!ledger.committed) await this.#undoClaims(ledger, ref);
		}
	}

	#variantEditApplying(
		input: UpdateProductVariantFieldsInput,
		key: IdempotencyKey,
		expectedUpdatedAt: string,
		ref: SkuOwnerRef,
		ledger: SkuClaimLedger,
	): Promise<ProductVariantUpdateResult> {
		const clearStamp = (token: string): Promise<void> =>
			this.#clearVariantStamp(input.productId, input.variantKey, token);
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

			const owed = await this.#settleRecorded(existing.pendingRenames, ref, clearStamp);
			EmdashProductCommerceStore.#refuseWhileOwed(owed, existing.sku, input.sku);
			const prepared = await this.#prepareSku(ledger, ref, existing.sku, input.sku, key);
			if (prepared === CONTENDED) return CAS_RETRY;
			const updated: ProductVariantDoc = {
				...existing,
				pendingRenames: EmdashProductCommerceStore.#withRecord(
					existing.pendingRenames,
					prepared.carry,
				),
				sku: input.sku ?? existing.sku,
				price: input.price ?? existing.price,
				idempotencyKey: key,
				updatedAt: this.#clock.now().toISOString(),
			};
			if (prepared.hold !== null && !(await this.#heartbeatClaim(prepared.hold, ref, ledger))) {
				return CAS_RETRY;
			}
			const written = await this.#products.compareAndSet(input.productId, current.revision, {
				...doc,
				variants: { ...doc.variants, [input.variantKey]: updated },
			});
			if (!written.applied) return CAS_RETRY;
			ledger.committed = true;
			await this.#settleWrite(prepared, ref, clearStamp);
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
	 * Decide the sku axis of an APPLYING write, without moving any stock.
	 *
	 * The order is the port's, and each refusal is resolved BEFORE the product write
	 * commits so that a refused rename leaves nothing behind:
	 *  1. the `sku_owners` claim — `SkuConflictError`, which outranks both stock
	 *     refusals and is settled before any inventory document is touched;
	 *  2. the source's live holds — `SkuHeldStockError`;
	 *  3. the target's occupancy — `SkuStockConflictError`, decided by CLAIMING the
	 *     target create-if-absent, so holding the claim also guarantees the move
	 *     cannot be refused for that reason later.
	 *
	 * What comes back is the carry to RECORD in the committing write and run after it,
	 * never a carry already performed.
	 */
	async #prepareSku(
		ledger: SkuClaimLedger,
		ref: SkuOwnerRef,
		currentSku: Sku | null,
		nextSku: Sku | undefined,
		commandKey: string,
	): Promise<SkuPreparation | typeof CONTENDED> {
		if (nextSku === undefined) return { carry: null, releaseSku: null, hold: null };
		const claim = await this.#claimSku(nextSku, ref, currentSku);
		if (claim.createdNow) ledger.claimed = nextSku;
		const hold: SkuHold = {
			sku: nextSku,
			revision: claim.revision,
			createsTarget: claim.createsTarget,
		};
		if (currentSku === null || currentSku === nextSku) {
			return { carry: null, releaseSku: null, hold };
		}
		let outcome: "created" | "adopted" | "contended";
		try {
			outcome = await this.#transfer.prepare(currentSku, nextSku, {
				targetIsOurs: claim.alreadyOurs,
				occupiedAtClaim: claim.occupiedAtClaim,
			});
		} catch (err) {
			// A refusal ends the call, so the claim goes back at once rather than waiting
			// for the undo: the operator's next attempt must find the sku free.
			await this.#undoClaims(ledger, ref);
			throw err;
		}
		if (outcome === "contended") {
			ledger.contended++;
			if (ledger.contended > TARGET_CLAIM_CONTENTION_ATTEMPTS) {
				await this.#undoClaims(ledger, ref);
				throw new SkuStockConflictError(currentSku, nextSku);
			}
			return CONTENDED;
		}
		if (outcome === "created") ledger.createdTarget = nextSku;
		return {
			carry: {
				token: skuTransferToken(commandKey, currentSku, nextSku),
				fromSku: currentSku,
				toSku: nextSku,
				commandKey,
			},
			releaseSku: currentSku,
			hold,
		};
	}

	/**
	 * RE-ASSERT the sku claim immediately before the product document commits, and
	 * re-stamp its lease while doing it.
	 *
	 * **The hole this closes.** `#claimSku` proves ownership when the claim is taken,
	 * not when the write lands, and the two are different instants. A writer that
	 * stalls past {@link CLAIM_ABANDON_AFTER_MS} between them has its claim taken over
	 * as abandoned — correctly, from the newcomer's point of view — and then resumes and
	 * commits its product document anyway, because that compare-and-set guards the
	 * PRODUCT document's revision and can see nothing at all about the claim. Two live
	 * rows would then name one sku, and the stalled writer's carry would deposit its
	 * units under a sku the newcomer owns.
	 *
	 * So the claim is compare-and-set at the revision this call last saw, carrying a
	 * fresh `claimedAt`. That single write does both jobs: it PROVES the claim is still
	 * ours (a takeover changed the revision, so the write fails), and it restarts the
	 * lease from the commit attempt, so a writer that is merely slow — a retry storm on
	 * a contended document — keeps its claim instead of being reaped for being busy. It
	 * runs on EVERY attempt of the retry loop, for that reason.
	 *
	 * Returns false when the claim moved but is still ours (a peer of the same owner
	 * heartbeat it first): the step re-runs. Throws `SkuConflictError` — the port's
	 * own live-sku refusal, already mapped to 409 at the boundary — when it is gone,
	 * and the product document is NOT written.
	 *
	 * **The residual, stated exactly.** Two-document atomicity does not exist here, so
	 * this closes the window down to the gap between two ADJACENT statements: the
	 * heartbeat and the product compare-and-set. A pause of the FULL lease length in
	 * that gap would still be overtaken. That is the residual every lease scheme has,
	 * and 60 s is what makes it unreachable in practice: the entire retry budget is
	 * `CAS_MAX_ATTEMPTS` (24) attempts with each sleep capped at `CAS_MAX_DELAY_MS`
	 * (50 ms), under two seconds end to end, so a pause thirty times longer than the
	 * whole budget would have to land between two consecutive awaits.
	 *
	 * **Clock skew.** The lease compares the READER's clock against the CLAIMANT's
	 * `claimedAt`, so two workers whose clocks disagree measure different ages: a
	 * reader running fast may judge a live claim abandoned early, one running slow may
	 * wait longer than a minute. The heartbeat decides who loses, and it is always the
	 * SLOW writer rather than the data: an early takeover moves the claim's revision,
	 * so the original writer's pre-commit compare-and-set fails and it refuses typed
	 * instead of committing a second live row. Skew therefore costs a merchant a
	 * spurious retry, never a sku with two owners.
	 */
	async #heartbeatClaim(hold: SkuHold, ref: SkuOwnerRef, ledger: SkuClaimLedger): Promise<boolean> {
		const at = this.#clock.now().toISOString();
		const written = await this.#skuOwners.compareAndSet(
			hold.sku,
			hold.revision,
			newSkuOwnerDoc(hold.sku, ref, at, hold.createsTarget),
		);
		if (written.applied) {
			hold.revision = written.revision;
			return true;
		}
		const current = await this.#skuOwners.get(hold.sku);
		// Still ours, at a revision we had not seen: a peer of this same owner got there
		// first. Nothing is lost — the step re-reads and re-decides.
		if (current !== null && current.live && isOwnedBy(current, ref)) return false;
		// Gone. Neither the claim nor anything under it is ours to give back now, so the
		// undo must not touch them: releasing a claim we no longer hold is a no-op, but
		// withdrawing an inventory document the newcomer has adopted would not be.
		ledger.claimed = null;
		ledger.createdTarget = null;
		throw new SkuConflictError(hold.sku);
	}

	/**
	 * Everything an applying write owes once its compare-and-set has WON: move the
	 * stock it recorded, drop the record, and release the sku it moved off.
	 *
	 * A `SkuHeldStockError` here is not a refusal — the rename is already committed —
	 * but a hold that arrived between the decision and the move. The recorded intent is
	 * LEFT IN PLACE and the sweeper (or the next write on this product) completes the
	 * move once the hold resolves. Stock is conserved throughout: the units are still on
	 * the source, and the source still names where they are going.
	 *
	 * **And the SOURCE's claim is kept, which is the half that is easy to get wrong.**
	 * Releasing it while the carry is owed would leave a sku that still HOLDS units
	 * looking free. A different owner would then take it and ADOPT those units under THE
	 * FIRST-SKU ASYMMETRY — first assignment adopts, by design — and the eventual
	 * completion of the blocked carry would zero them out from under it and deposit them
	 * in the first product's target. The claim is therefore released only by whoever
	 * finishes the move; see {@link EmdashProductCommerceStore.#settleRecorded}.
	 */
	async #settleWrite(
		prepared: SkuPreparation,
		ref: SkuOwnerRef,
		clearStamp: (token: string) => Promise<void>,
	): Promise<void> {
		if (prepared.carry !== null) {
			const carry = prepared.carry;
			try {
				await this.#transfer.move(carry.fromSku, carry.toSku, carry.token, carry.commandKey);
				await clearStamp(carry.token);
			} catch (err) {
				if (!(err instanceof SkuHeldStockError)) throw err;
				// Owed, not done: the source keeps its units AND its claim.
				return;
			}
		}
		if (prepared.releaseSku !== null) await this.#releaseSku(prepared.releaseSku, ref);
	}

	/**
	 * Finish the carries a document already records, before a new write moves the same
	 * skus — the "any replayer completes it" half of the intent-claim, reached on the
	 * ordinary write path rather than only by a sweeper.
	 *
	 * Best-effort and never fatal: a carry that still cannot move (a live hold on its
	 * source) keeps its record and is tried again by the next write or the sweep. The
	 * records are a MAP keyed by token, so settling one never disturbs another and a
	 * new write never destroys an outstanding one.
	 */
	async #settleRecorded(
		records: Record<string, PendingRenameDoc> | undefined,
		ref: SkuOwnerRef,
		clearStamp: (token: string) => Promise<void>,
	): Promise<SkuHeldStockError | undefined> {
		let blocked: SkuHeldStockError | undefined;
		for (const carry of Object.values(records ?? {})) {
			try {
				await this.#transfer.move(carry.fromSku, carry.toSku, carry.token, carry.commandKey);
				await clearStamp(carry.token);
				// The source is empty at last, so the sku it was holding onto is free. This
				// is the ONLY place a blocked rename's source claim is given back, which is
				// what keeps another owner from adopting units the carry had not yet moved.
				await this.#releaseSku(carry.fromSku, ref);
			} catch (err) {
				if (!(err instanceof SkuHeldStockError)) throw err;
				blocked ??= err;
			}
		}
		return blocked;
	}

	/**
	 * Refuse a NEW rename while this owner still owes an unfinished one.
	 *
	 * Without it a product could rename A→B, have that carry blocked by a hold on A,
	 * and then rename B→C — leaving the first carry to eventually deposit A's units
	 * into B, a sku nothing holds any more. Stock would still be conserved, but parked
	 * under a name no longer in use.
	 *
	 * The refusal reports the error that blocked the outstanding carry, which is the
	 * true reason and the one that clears by itself: the product's units are mid-move
	 * and cannot move again until the hold on the source resolves. Writes that do NOT
	 * touch the sku are unaffected — a title sync must never be refused by this.
	 */
	static #refuseWhileOwed(
		blocked: SkuHeldStockError | undefined,
		currentSku: Sku | null,
		nextSku: Sku | undefined,
	): void {
		if (blocked === undefined) return;
		if (nextSku === undefined || nextSku === currentSku) return;
		throw blocked;
	}

	/**
	 * Give back what a call took but never committed.
	 *
	 * Only ever undoes writes THIS call made: a `sku_owners` claim it created (back to
	 * released, so the next claimant takes it over) and a target inventory document it
	 * created that has never held a unit. Anything a peer has since touched is left
	 * alone by the guards inside each step.
	 */
	async #undoClaims(ledger: SkuClaimLedger, ref: SkuOwnerRef): Promise<void> {
		const { claimed, createdTarget } = ledger;
		ledger.claimed = null;
		ledger.createdTarget = null;
		if (createdTarget !== null) await this.#transfer.withdrawPristineClaim(createdTarget);
		if (claimed !== null) await this.#releaseSku(claimed, ref);
	}

	/** Drop one recorded carry from a product document, once its units have landed. */
	async #clearProductStamp(productId: ProductId, token: string): Promise<void> {
		await this.#cas<void>("clearRenameRecord", async () => {
			const current = await this.#products.getVersioned(productId);
			if (current === null) return casDone(undefined);
			const doc = normalizeProductDoc(current.value);
			if (doc.pendingRenames?.[token] === undefined) return casDone(undefined);
			const { [token]: _done, ...rest } = doc.pendingRenames;
			const written = await this.#products.compareAndSet(productId, current.revision, {
				...doc,
				pendingRenames: Object.keys(rest).length === 0 ? undefined : rest,
			});
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
	}

	/** The same, for a carry recorded on one embedded variant. */
	async #clearVariantStamp(productId: ProductId, variantKey: string, token: string): Promise<void> {
		await this.#cas<void>("clearRenameRecord", async () => {
			const current = await this.#products.getVersioned(productId);
			if (current === null) return casDone(undefined);
			const doc = normalizeProductDoc(current.value);
			const variant = doc.variants[variantKey];
			if (variant?.pendingRenames?.[token] === undefined) return casDone(undefined);
			const { [token]: _done, ...rest } = variant.pendingRenames;
			const written = await this.#products.compareAndSet(productId, current.revision, {
				...doc,
				variants: {
					...doc.variants,
					[variantKey]: {
						...variant,
						pendingRenames: Object.keys(rest).length === 0 ? undefined : rest,
					},
				},
			});
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
	}

	/** Merge one recorded carry into a document's record map. */
	static #withRecord(
		records: Record<string, PendingRenameDoc> | undefined,
		carry: PendingRenameDoc | null,
	): Record<string, PendingRenameDoc> | undefined {
		if (carry === null) return records;
		return { ...records, [carry.token]: carry };
	}

	/**
	 * Claim `sku` for `ref`, or refuse.
	 *
	 * Outcomes, and the distinctions are all load-bearing:
	 *  - no document ⇒ create-if-absent, which is a DB-level
	 *    `INSERT … ON CONFLICT DO NOTHING` and therefore race-safe;
	 *  - a RELEASED document (`live: false`) ⇒ taken over by compare-and-set on its
	 *    revision, which is how a sku freed by a soft delete or an orphaning is reused;
	 *  - a LIVE document already held by `ref` ⇒ nothing to do, and the caller is told
	 *    it was already ours;
	 *  - a LIVE document held by somebody else ⇒ see {@link ClaimStatus}: `held` and
	 *    `owed` refuse, `in-flight` refuses, and `abandoned` is taken over.
	 *
	 * **Why a live claim's backing is examined at all.** The claim is written one round
	 * trip before the document that will hold the sku, so for that round trip a live
	 * claim can exist that no committed row backs. Answering `SkuConflictError` there
	 * would state something false — "another live product holds this sku" — about a peer
	 * holding nothing. So an unbacked live claim falls through to the stock question:
	 * with an inventory document present and a source sku to name, the honest refusal is
	 * `SkuStockConflictError`, which is what the operator can act on and what the SQL
	 * adapter answered, its partial unique index having had nothing to say about a sku no
	 * live row held.
	 *
	 * **And why an abandoned one is taken over.** That same round trip is durable if the
	 * process dies inside it. See {@link CLAIM_ABANDON_AFTER_MS} for the lease, and
	 * {@link SkuOwnerDoc.createsTarget} for the inventory residue a takeover also clears.
	 *
	 * `fromSku` is the sku the write is moving away from, needed to name both ends of a
	 * stock refusal; `null` for a first assignment, which has no stock question.
	 */
	#claimSku(sku: string, ref: SkuOwnerRef, fromSku: Sku | null): Promise<SkuClaim> {
		return this.#cas<SkuClaim>("claimSku", async () => {
			const current = await this.#skuOwners.getVersioned(sku);
			// Read BEFORE the claim is written, so the answer can travel IN it: a takeover
			// has to know whether the claim it is replacing created an inventory document,
			// and a claim cannot record that about itself after the fact without a second
			// write on every rename.
			const occupied = await this.#occupiedNow(sku, fromSku);
			const at = this.#clock.now().toISOString();
			// ONE derivation, used both for the document written and for the answer
			// returned, so the persisted flag and the caller's copy cannot disagree. A
			// claim creates the target only when this write is a rename AND the sku had no
			// inventory document when the claim was won.
			const creates = (occupiedNow: boolean): boolean =>
				fromSku !== null && fromSku !== sku && !occupiedNow;

			if (current === null) {
				const createsTarget = creates(occupied);
				const written = await this.#skuOwners.compareAndSet(
					sku,
					null,
					newSkuOwnerDoc(sku, ref, at, createsTarget),
				);
				if (!written.applied) return CAS_RETRY;
				return casDone<SkuClaim>({
					alreadyOurs: false,
					createdNow: true,
					occupiedAtClaim: occupied,
					createsTarget,
					revision: written.revision,
				});
			}
			if (current.value.live) {
				if (isOwnedBy(current.value, ref)) {
					return casDone<SkuClaim>({
						alreadyOurs: true,
						createdNow: false,
						// Already ours means the occupancy question was settled when the claim
						// was won, so there is nothing here for the carry to refuse on. The
						// creation question is NOT settled the same way, and must come from
						// the fresh read: a peer of this owner — or `seedOnHand` — may have
						// created the document since, in which case this write creates
						// nothing and a later takeover must not withdraw what it finds.
						occupiedAtClaim: false,
						createsTarget: creates(occupied),
						revision: current.revision,
					});
				}
				const status = await this.#claimStatus(current.value, sku);
				if (status !== "abandoned") {
					if (status === "held") throw new SkuConflictError(sku);
					// `owed` and `in-flight` are both "somebody else's, right now". With units
					// under the sku and a source to name, the stock refusal is the more
					// specific true one.
					if (fromSku !== null && (await this.#inventory.get(sku)) !== null) {
						throw new SkuStockConflictError(fromSku, sku);
					}
					throw new SkuConflictError(sku);
				}
				// An abandoned claim's inventory residue goes with it, or the sku stays
				// wedged behind a document that only a dead writer ever wanted.
				if (current.value.createsTarget === true) {
					await this.#transfer.withdrawPristineClaim(sku);
				}
			}
			// Re-read: a takeover that just withdrew a residue must not remember the
			// document it removed, as an occupancy or as something it did not create.
			const afterOccupied = await this.#occupiedNow(sku, fromSku);
			const createsTarget = creates(afterOccupied);
			const written = await this.#skuOwners.compareAndSet(
				sku,
				current.revision,
				newSkuOwnerDoc(sku, ref, at, createsTarget),
			);
			if (!written.applied) return CAS_RETRY;
			return casDone<SkuClaim>({
				alreadyOurs: false,
				createdNow: true,
				occupiedAtClaim: afterOccupied,
				createsTarget,
				revision: written.revision,
			});
		});
	}

	/**
	 * Does the sku have an inventory document RIGHT NOW — read the instant this owner
	 * wins its claim, which is what makes a later lost claim decidable.
	 *
	 * `false` without reading when there is no source sku: a first assignment moves no
	 * stock, so there is no occupancy question and the document it finds is the one it
	 * ADOPTS (THE FIRST-SKU ASYMMETRY).
	 */
	async #occupiedNow(sku: string, fromSku: Sku | null): Promise<boolean> {
		if (fromSku === null || fromSku === sku) return false;
		return (await this.#inventory.get(sku)) !== null;
	}

	/** What a live claim held by another owner means; see {@link ClaimStatus}. */
	async #claimStatus(claim: SkuOwnerDoc, sku: string): Promise<ClaimStatus> {
		const stored = await this.#products.get(claim.ownerId);
		if (stored !== null) {
			const doc = normalizeProductDoc(stored);
			if (this.#claimIsBacked(doc, claim, sku)) return "held";
			if (owesCarryFrom(doc, claim, sku)) return "owed";
		}
		const age = this.#clock.now().getTime() - new Date(claim.claimedAt).getTime();
		return age >= this.#claimAbandonAfterMs ? "abandoned" : "in-flight";
	}

	/**
	 * Does the document this claim names actually hold this sku, committed?
	 *
	 * A claim whose owner holds the sku on a live product row (or a non-orphaned
	 * variant) is BACKED, and refusing it is a statement of fact.
	 */
	#claimIsBacked(doc: ProductCommerceDoc, claim: SkuOwnerDoc, sku: string): boolean {
		if (claim.ownerKind === "product") return doc.lifecycle === "live" && doc.sku === sku;
		if (claim.variantKey === null) return false;
		const variant = doc.variants[claim.variantKey];
		return variant !== undefined && variant.orphanedAt === null && variant.sku === sku;
	}

	/**
	 * Re-claim a sku for a RESURRECTING variant, reporting the claim it won or `null`
	 * when the sku is no longer available — never throwing, because a declare states a
	 * fact about the CMS and cannot be refused.
	 *
	 * `null` means another live sellable unit took the sku while this variant was
	 * orphaned, and the resurrect clears it. The claim it DOES win is returned as a hold
	 * so the caller can re-assert it before committing, exactly like every other write
	 * that takes a sku: a resurrect is slower than most (it resolves the product's
	 * currency too), so it is no less exposed to being overtaken while it works.
	 */
	async #reclaimSku(sku: string, ref: SkuOwnerRef): Promise<SkuHold | null> {
		try {
			// `null` as the source: a resurrect moves no stock, so there is no stock
			// question and a refusal here can only be the sku conflict it reports.
			const claim = await this.#claimSku(sku, ref, null);
			return { sku, revision: claim.revision, createsTarget: claim.createsTarget };
		} catch (err) {
			if (err instanceof SkuConflictError) return null;
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
