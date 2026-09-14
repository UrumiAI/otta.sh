/**
 * The product-commerce document model: one aggregate document per product, with
 * its variants embedded in it, plus one claim document per live sku.
 *
 * **Why the variants live inside the product document.** Every invariant that
 * spans a product and its sizes is a currency invariant — a repricing must not
 * leave a live size holding another currency, and a first pricing of one size
 * must not disagree with a sibling's. In SQL those were resolved by taking the
 * parent row's lock first, in a written-down lock order, and the order was only
 * *mostly* total (its own docblock says so). Embedded, the two writers contend
 * for ONE document revision, so the interleaving the lock order existed to
 * forbid is unreachable rather than merely ordered — and `updateVariantFields`
 * resolves the product's currency from the same value it is about to write.
 *
 * **A variant may arrive before its product row, so presence is a field.** The
 * CMS delivers `content:afterSave` and the repeater's rows as independent
 * fire-and-forget calls, and the port requires a variant to land regardless. The
 * document is therefore created by whichever write arrives first, and
 * {@link ProductCommerceDoc.lifecycle} says whether a *product row* exists at
 * all: `"absent"` is a document that only holds variants, and `getByProductId`
 * answers `null` for it exactly as it would for a document that does not exist.
 * That is also what keeps such a shell out of every list — the lists filter on
 * `lifecycle`, which is one indexed field carrying the three states the port
 * distinguishes (live, tombstoned, no row) where a nullable `deletedAt` could
 * only carry two (the filter algebra has no negation, so "tombstoned" cannot be
 * expressed as "not null").
 *
 * **Live-sku uniqueness is a claim document, not an index.** `sku_owners/{sku}`
 * names the one live sellable unit that holds a sku — a product row or a variant
 * — and it is written create-if-absent, which is a DB-level
 * `INSERT … ON CONFLICT DO NOTHING`. The two partial unique indexes it replaces
 * (`UNIQUE (sku) WHERE deleted_at IS NULL` and `… WHERE orphaned_at IS NULL`)
 * were unique *among live rows only*, and that "among live rows" becomes
 * {@link SkuOwnerDoc.live}: a soft delete or an orphaning releases the claim, and
 * a new claimant takes over a released document by compare-and-set. No unique
 * index is relied upon anywhere — the harness cannot materialize one and the
 * host's index sync degrades silently (ADR-0019 §5).
 *
 * Dates are stored as ISO-8601 UTC text, never as `Date`: a `Date` does not
 * round-trip through a JSON column, and ISO text compares lexicographically
 * exactly as it compares chronologically, which is what every watermark guard on
 * this port already relies on. Branded types (`Money`, `Sku`, `ProductId`,
 * `IdempotencyKey`) are stored as themselves — the brands are erased at runtime,
 * so the stored JSON is plain, and the same convention the order documents use.
 */
import type {
	IdempotencyKey,
	InventoryPolicy,
	Money,
	ProductCommerce,
	ProductId,
	ProductKind,
	ProductSummary,
	ProductVariant,
	ProductVariantSummary,
	Sku,
} from "@otta-sh/domain";

/** Collection name: the per-product aggregate, variants embedded. */
export const PRODUCT_COMMERCE_COLLECTION = "product_commerce";
/** Collection name: the live-sku uniqueness claim, one document per sku. */
export const SKU_OWNERS_COLLECTION = "sku_owners";

/** One collection as the plugin descriptor declares it. */
export interface CollectionIndexDeclaration {
	readonly indexes?: readonly string[];
	readonly uniqueIndexes?: readonly string[];
}

/**
 * The two collections `EmdashProductCommerceStore` owns, with the indexes each
 * must declare. A declared index is a **read contract**, not a performance knob:
 * a `where`/`orderBy` on an undeclared field is a runtime `StorageQueryError`, so
 * this list and the descriptor's must not drift.
 *
 * `productId` is declared — even though it IS the document id — because the two
 * BATCH reads (`getManyByProductId`, `listCommerceByIds`) fetch a whole batch with
 * one `productId in [...]` query instead of a `get` per id. That is the surviving
 * half of the port's anti-N+1 invariant: a document store has no join, so the stock
 * a view needs is still one read per distinct sku, but the product half stays one
 * statement per 100 ids exactly as the SQL was one statement per batch.
 *
 * `lifecycle`, `publishKey`, `productKind` and `taxClass` are the equality axes the
 * admin list and `countByTaxClass` filter on; `createdAt` is what the list
 * ORDERS by, and ordering on an undeclared field throws exactly as filtering on
 * one does.
 *
 * **`active` is filtered through a STRING mirror, `publishKey`, and that is a
 * driver constraint rather than a preference.** A `where` value is bound as a
 * parameter, and better-sqlite3 binds only numbers, strings, bigints, buffers and
 * null — a boolean throws `SQLite3 can only bind …` before any comparison runs.
 * So the publish gate is stored twice: `active` is the boolean the port reads back,
 * and `publishKey` is the indexed text the filter binds. {@link publishKeyFor} is
 * the only thing that derives one from the other, so they cannot drift.
 *
 * **`titleLower` is deliberately NOT declared, against ADR-0019 §4's table.**
 * The port's `search` is a case-insensitive SUBSTRING on the title (it says so,
 * and the contract pins it), and the filter algebra has no `contains` — so no
 * declared index could serve it and declaring one would be a read contract for a
 * query that is never issued. The title half of the search is resolved in memory
 * over the rows the indexed axes already narrowed; see
 * `EmdashProductCommerceStore.listProducts`.
 *
 * `sku_owners` declares its natural key, which IS its document id — a lookup
 * plan, never the enforcement (ADR-0019 §4's `uniqueIndexes` rule). The store
 * reaches it by id alone.
 */
export const PRODUCT_COMMERCE_COLLECTIONS: Readonly<Record<string, CollectionIndexDeclaration>> = {
	[PRODUCT_COMMERCE_COLLECTION]: {
		indexes: ["productId", "lifecycle", "publishKey", "productKind", "taxClass", "createdAt"],
	},
	[SKU_OWNERS_COLLECTION]: { uniqueIndexes: ["sku"] },
};

/**
 * Whether a product ROW exists under this document, and in which state.
 *
 * One indexed field rather than a nullable tombstone, because the port asks three
 * questions of it and an AND-only filter with no negation can only answer two
 * from a nullable column: the default list wants live rows, the archive view
 * wants tombstoned ones, and BOTH must skip a document that carries variants but
 * no product row.
 */
export type ProductLifecycle =
	/** A product row exists and is not soft-deleted. */
	| "live"
	/** A product row exists and carries a tombstone. */
	| "deleted"
	/** No product row: the document exists only because a variant landed first. */
	| "absent";

/**
 * The publish gate as indexed text. A boolean cannot be bound as a `where` value
 * on better-sqlite3, so the filterable form of `active` is this.
 */
export type PublishKey = "active" | "inactive";

/** The ONE derivation of {@link PublishKey} from the gate, so the two cannot drift. */
export function publishKeyFor(active: boolean): PublishKey {
	return active ? "active" : "inactive";
}

/** One embedded variant — a sellable unit of its product, keyed by its own key. */
export interface ProductVariantDoc {
	/** The CMS repeater row's stable, immutable key; also the map key. */
	variantKey: string;
	/** Admin-owned. Null until priced; cleared only by a resurrect that lost it. */
	sku: Sku | null;
	price: Money | null;
	/** CMS-owned display-name cache (ADR-0016). */
	title: string | null;
	/** The orphan tombstone, ISO-8601 UTC; null while the variant is live. */
	orphanedAt: string | null;
	idempotencyKey: IdempotencyKey;
	/** The ONE watermark ordering both presence transitions. */
	contentUpdatedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * `product_commerce/{productId}` — the aggregate. Every field of the port's
 * `ProductCommerce` plus the embedded variants, the publish-gate watermark, and
 * the indexed lifecycle discriminator.
 */
export interface ProductCommerceDoc {
	/** INDEXED — the document id, repeated as a field so a batch can be read with `in`. */
	productId: ProductId;
	/** INDEXED. See {@link ProductLifecycle}. */
	lifecycle: ProductLifecycle;
	sku: Sku | null;
	price: Money | null;
	/** CMS-owned single-writer cache (ADR-0013). */
	title: string | null;
	/** INDEXED — `countByTaxClass`'s only predicate. */
	taxClass: string | null;
	compareAtPrice: Money | null;
	unitCost: Money | null;
	inventoryPolicy: InventoryPolicy;
	weightGrams: number | null;
	lengthMm: number | null;
	widthMm: number | null;
	heightMm: number | null;
	/** INDEXED. */
	productKind: ProductKind;
	/** The publish gate as the port reads it. NOT indexed — see `publishKey`. */
	active: boolean;
	/** INDEXED text mirror of {@link ProductCommerceDoc.active}; see the layout doc. */
	publishKey: PublishKey;
	/** ISO-8601 UTC; null while live. Mirrored, for filtering, by `lifecycle`. */
	deletedAt: string | null;
	idempotencyKey: IdempotencyKey;
	/** The sync watermark `upsert` orders on. */
	contentUpdatedAt: string | null;
	/**
	 * The PUBLISH-GATE watermark, deliberately separate from
	 * {@link ProductCommerceDoc.contentUpdatedAt}: a plain content save advances
	 * that one without being a lifecycle event, so sharing it would let a save
	 * poison the gate and hand a stale `activate` the win. Mirrors the SQL
	 * adapter's own `active_updated_at` column. Null until a lifecycle event lands.
	 */
	activeUpdatedAt: string | null;
	/** INDEXED — what the admin list orders by. */
	createdAt: string;
	updatedAt: string;
	/** The embedded sellable units, keyed by `variantKey`. */
	variants: Record<string, ProductVariantDoc>;
}

/** Which grain holds a sku claim. */
export type SkuOwnerKind = "product" | "variant";

/**
 * `sku_owners/{sku}` — the live-sku uniqueness claim (ADR-0019 R4).
 *
 * `live: false` is a RELEASED claim: the owner was soft-deleted, orphaned, or
 * renamed away, so the sku is free and a new claimant may take the document over
 * by compare-and-set on its revision. The document is retained rather than
 * deleted so the takeover is one guarded write instead of a delete-then-insert
 * with a window in the middle.
 */
export interface SkuOwnerDoc {
	/** The claimed sku — the document id, repeated as a field for the declaration. */
	sku: string;
	ownerKind: SkuOwnerKind;
	/** The product that holds the sku, or whose variant does. */
	ownerId: ProductId;
	/** The variant key when `ownerKind` is `"variant"`; null for a product row. */
	variantKey: string | null;
	/** False once the owner released it (soft delete, orphan, or rename away). */
	live: boolean;
	claimedAt: string;
}

/** Who is asking about a sku claim — a product row, or one variant of one. */
export type SkuOwnerRef =
	| { kind: "product"; productId: ProductId }
	| { kind: "variant"; productId: ProductId; variantKey: string };

/** Does this claim belong to `ref`? Re-supplying one's own sku is no conflict. */
export function isOwnedBy(claim: SkuOwnerDoc, ref: SkuOwnerRef): boolean {
	if (claim.ownerKind !== ref.kind || claim.ownerId !== ref.productId) return false;
	return ref.kind === "product" ? true : claim.variantKey === ref.variantKey;
}

/** The claim document a fresh (or taken-over) claim writes. */
export function newSkuOwnerDoc(sku: string, ref: SkuOwnerRef, claimedAt: string): SkuOwnerDoc {
	return {
		sku,
		ownerKind: ref.kind,
		ownerId: ref.productId,
		variantKey: ref.kind === "variant" ? ref.variantKey : null,
		live: true,
		claimedAt,
	};
}

/**
 * The document a write creates when it is the FIRST to touch this product — a
 * shell with no product row (`lifecycle: "absent"`), which is what a variant
 * declared ahead of its `content:afterSave` produces.
 *
 * Every product field is at its default so the document shape never varies by
 * creation path; none of them is readable until a product-level write flips
 * `lifecycle` to `"live"` and sets them for real.
 */
export function newShellProductDoc(productId: ProductId, at: string): ProductCommerceDoc {
	return {
		productId,
		lifecycle: "absent",
		sku: null,
		price: null,
		title: null,
		taxClass: null,
		compareAtPrice: null,
		unitCost: null,
		inventoryPolicy: "deny",
		weightGrams: null,
		lengthMm: null,
		widthMm: null,
		heightMm: null,
		productKind: "physical",
		active: false,
		publishKey: "inactive",
		deletedAt: null,
		idempotencyKey: "" as IdempotencyKey,
		contentUpdatedAt: null,
		activeUpdatedAt: null,
		createdAt: at,
		updatedAt: at,
		variants: {},
	};
}

/**
 * Normalize a stored aggregate so `variants` is always present.
 *
 * A document written by an earlier build (or by a seed path) may lack it, and
 * `noUncheckedIndexedAccess` protects the element type, not the container.
 */
export function normalizeProductDoc(doc: ProductCommerceDoc): ProductCommerceDoc {
	return { ...doc, variants: doc.variants ?? {} };
}

/** Is there a readable product row here? `"absent"` reads as "no such product". */
export function hasProductRow(doc: ProductCommerceDoc): boolean {
	return doc.lifecycle !== "absent";
}

/** The lifecycle a row's tombstone implies — the ONE place the two stay in step. */
export function lifecycleFor(deletedAt: string | null): ProductLifecycle {
	return deletedAt === null ? "live" : "deleted";
}

/** The port's row, rebuilt from the document. Dates come back as `Date`. */
export function toProductCommerce(doc: ProductCommerceDoc): ProductCommerce {
	return {
		productId: doc.productId,
		sku: doc.sku,
		price: doc.price,
		title: doc.title,
		taxClass: doc.taxClass,
		compareAtPrice: doc.compareAtPrice,
		unitCost: doc.unitCost,
		inventoryPolicy: doc.inventoryPolicy,
		weightGrams: doc.weightGrams,
		lengthMm: doc.lengthMm,
		widthMm: doc.widthMm,
		heightMm: doc.heightMm,
		productKind: doc.productKind,
		active: doc.active,
		deletedAt: doc.deletedAt === null ? null : new Date(doc.deletedAt),
		idempotencyKey: doc.idempotencyKey,
		contentUpdatedAt: doc.contentUpdatedAt,
		createdAt: new Date(doc.createdAt),
		updatedAt: new Date(doc.updatedAt),
	};
}

/**
 * The admin list's projection. `onHand` carries the port's THREE states
 * unchanged: `null` is "no inventory document for this sku, or no sku at all"
 * (UNKNOWN, never rendered as `0`) and `0` is a known sku out of stock.
 */
export function toProductSummary(doc: ProductCommerceDoc, onHand: number | null): ProductSummary {
	return {
		productId: doc.productId,
		sku: doc.sku,
		title: doc.title,
		price: doc.price,
		productKind: doc.productKind,
		active: doc.active,
		onHand,
		deletedAt: doc.deletedAt,
		createdAt: doc.createdAt,
	};
}

/** The port's variant row, rebuilt from its embedded document. */
export function toProductVariant(productId: ProductId, variant: ProductVariantDoc): ProductVariant {
	return {
		productId,
		variantKey: variant.variantKey,
		sku: variant.sku,
		price: variant.price,
		title: variant.title,
		orphanedAt: variant.orphanedAt === null ? null : new Date(variant.orphanedAt),
		idempotencyKey: variant.idempotencyKey,
		contentUpdatedAt: variant.contentUpdatedAt,
		createdAt: new Date(variant.createdAt),
		updatedAt: new Date(variant.updatedAt),
	};
}

/**
 * `listVariants`'s row: the stored variant NARROWED (the replay key and the sync
 * watermark are write-path bookkeeping and never reach a reader), plus stock.
 */
export function toVariantSummary(
	productId: ProductId,
	variant: ProductVariantDoc,
	onHand: number | null,
): ProductVariantSummary {
	const {
		idempotencyKey: _key,
		contentUpdatedAt: _watermark,
		...rest
	} = toProductVariant(productId, variant);
	return { ...rest, onHand };
}

/** A fresh variant row: DECLARED by the CMS, priced by nobody yet. */
export function newVariantDoc(
	variantKey: string,
	title: string | null,
	key: IdempotencyKey,
	contentUpdatedAt: string | null,
	at: string,
): ProductVariantDoc {
	return {
		variantKey,
		// A variant is DECLARED by the CMS and PRICED by the admin: the sync
		// channel has no field for either, which is the whole of ADR-0016.
		sku: null,
		price: null,
		title,
		orphanedAt: null,
		idempotencyKey: key,
		contentUpdatedAt,
		createdAt: at,
		updatedAt: at,
	};
}

/** Every live (non-orphaned) variant of one document, unordered. */
export function liveVariants(doc: ProductCommerceDoc): ProductVariantDoc[] {
	return Object.values(doc.variants).filter((variant) => variant.orphanedAt === null);
}

/**
 * The currency a product's money must agree on: the product row's own price
 * currency when it has one, else that of any OTHER live priced variant (a product
 * whose sizes carry the money has no product-level price, and the sizes must
 * still agree with each other). `null` ⇒ nothing to match yet, so a first pricing
 * is free.
 *
 * Resolved from the SAME document the write is about to commit, which is what
 * replaces the SQL adapter's "take the parent row's lock first": a product
 * repricing and a variant pricing cannot both pass by reading each other's
 * "before" state, because only one of them can win the document's revision.
 */
export function resolveProductCurrency(
	doc: ProductCommerceDoc,
	exceptVariantKey: string | null,
): string | null {
	if (doc.price !== null) return doc.price.currency;
	for (const variant of liveVariants(doc)) {
		if (variant.variantKey === exceptVariantKey) continue;
		if (variant.price !== null) return variant.price.currency;
	}
	return null;
}

/** Descending code-unit comparison — the adapter's total order, never a locale. */
export function codeUnitDesc(a: string, b: string): number {
	return a > b ? -1 : a < b ? 1 : 0;
}

/** Ascending code-unit comparison — `listVariants`'s `variantKey ASC`. */
export function codeUnitAsc(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
