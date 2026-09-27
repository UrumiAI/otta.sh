import type { ProductCommerce } from "../ports/product-commerce-store.js";

/**
 * THE LIVENESS RULE — a product may be SOLD only while it is published and not
 * deleted: `active` (the CMS publish gate, flipped by `content:afterPublish` /
 * `content:afterUnpublish`) and no `deletedAt` tombstone (`content:afterDelete`).
 *
 * Pure and IO-free, so every sell path asks the same question instead of
 * re-deriving it: the add-to-cart guard, the checkout quote and
 * `createOrderFromCart`. Listing visibility (`joinProduct`'s `purchasable`) already
 * applies the same gate; without it here an unpublished or deleted product stayed
 * orderable from a cart — or through a direct add — at its last price.
 *
 * Price and title are NOT part of this rule; each caller checks those after it,
 * and refuses the line with the same `PRODUCT_NOT_PRICED` token either way.
 */
export function isProductLive(row: Pick<ProductCommerce, "active" | "deletedAt">): boolean {
	return row.active && row.deletedAt === null;
}
