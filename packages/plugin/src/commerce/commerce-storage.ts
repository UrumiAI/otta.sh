/**
 * The storage layout commerce truth lives in: every collection the
 * `@otta-sh/store-emdash` adapters read or write, with the indexes each one
 * declares.
 *
 * WHY IT IS ASSEMBLED HERE AND NOT IN THE ADAPTER PACKAGE. Each adapter module
 * owns the declaration for the collections it owns (`CART_COLLECTIONS`,
 * `ORDER_COLLECTIONS`, …) and the package deliberately publishes no union of
 * them: the union is a property of the DEPLOYMENT — which aggregates this
 * plugin actually holds — not of the adapters. The plugin is the deployment, so
 * the union is assembled here, by spreading the per-module constants rather than
 * by restating any collection name or index list. Nothing below may be typed out
 * by hand; a restated list is a list that drifts.
 *
 * A DECLARED INDEX IS A READ CONTRACT, not a performance knob: a `where` or
 * `orderBy` on a field the collection never declared is a runtime error, not a
 * slow query. That is why this list and the host descriptor's must be the same
 * object rather than two lists that happen to agree: the descriptor WILL import it
 * when the deployment flips to this transport, and until then this is the list the
 * test tiers bind their storage from.
 *
 * SANDBOX-CLEAN: type-only knowledge of the host, data only at runtime. Nothing
 * here executes host code, opens anything, or reads an environment.
 */

import {
	CART_COLLECTIONS,
	COUPON_COLLECTIONS,
	ENTITLEMENT_COLLECTIONS,
	IDENTITY_COLLECTIONS,
	INVENTORY_COLLECTIONS,
	ORDER_COLLECTIONS,
	ORDER_NOTES_COLLECTIONS,
	PAYMENT_EVENT_COLLECTIONS,
	PRODUCT_COMMERCE_COLLECTIONS,
	REPORTING_COLLECTIONS,
	RULES_COLLECTIONS,
	SETTINGS_COLLECTIONS,
} from "@otta-sh/store-emdash";

/**
 * One collection's declaration. A composite entry (`["state", "createdAt"]`) is
 * a multi-field ordering the host folds into the queryable-field allow-list field
 * by field; only the order collections declare any.
 */
export interface CommerceCollectionDeclaration {
	readonly indexes?: readonly (string | readonly string[])[];
	readonly uniqueIndexes?: readonly (string | readonly string[])[];
}

/** Collection name → its declared indexes. */
export type CommerceStorageLayout = Readonly<Record<string, CommerceCollectionDeclaration>>;

/**
 * Every collection commerce truth occupies. The spread order is irrelevant — the
 * per-module constants declare disjoint collections, which is a property rather
 * than a hope, so a case pins it: a collection declared by two modules would have
 * one module's indexes silently win here, and the loser's reads would fail at
 * runtime on a field it believed it had declared.
 *
 * FROZEN, because as of INC-D1 this is public API handed out BY REFERENCE: the
 * deploying site's descriptor returns this very object as its `storage` block, so
 * any holder of it holds the schema every `collectionOf` is validated against, and
 * a collection deleted from it at runtime is a dead commerce path. `Readonly<>`
 * says so to the type checker only, and the site widens through a cast on the way
 * in. The freeze is SHALLOW — enough to stop the collection SET being edited under
 * a holder, which is the mutation that would matter; the per-collection
 * declarations are the adapter packages' own constants and are theirs to freeze.
 */
export const COMMERCE_STORAGE_COLLECTIONS: CommerceStorageLayout = Object.freeze({
	...INVENTORY_COLLECTIONS,
	...CART_COLLECTIONS,
	...ORDER_COLLECTIONS,
	...ORDER_NOTES_COLLECTIONS,
	...PRODUCT_COMMERCE_COLLECTIONS,
	...COUPON_COLLECTIONS,
	...RULES_COLLECTIONS,
	...IDENTITY_COLLECTIONS,
	...ENTITLEMENT_COLLECTIONS,
	...PAYMENT_EVENT_COLLECTIONS,
	...SETTINGS_COLLECTIONS,
	...REPORTING_COLLECTIONS,
});

/** The collection names, for a caller that needs the list rather than the map. */
export const COMMERCE_STORAGE_COLLECTION_NAMES: readonly string[] = Object.keys(
	COMMERCE_STORAGE_COLLECTIONS,
);
