import type { ProductCommerce } from "../ports/product-commerce-store.js";

/**
 * THE LIVENESS RULE — a product may be SOLD only while it is published and not
 * deleted: `active` (the CMS publish gate, flipped by `content:afterPublish` /
 * `content:afterUnpublish`) and no `deletedAt` tombstone (`content:afterDelete`).
 *
 * The liveness half of {@link isProductSellable}; kept on its own for callers
 * that ask only about the lifecycle.
 */
export function isProductLive(row: Pick<ProductCommerce, "active" | "deletedAt">): boolean {
	return row.active && row.deletedAt === null;
}

/**
 * Why a product cannot be sold, in rank order: `deleted` outranks `unpublished`
 * (a tombstoned row is always inactive too), then the missing commercial facts.
 */
export type UnsellableReason = "deleted" | "unpublished" | "unpriced" | "untitled";

/**
 * The facts the sellability rule reads. Structural on purpose, so the store's row
 * and the plugin's catalog view are judged by the same function. `deletedAt` is
 * optional because the catalog read already drops tombstoned rows.
 */
export interface SellabilityFacts {
	readonly active: boolean;
	readonly deletedAt?: Date | string | null;
	readonly price: unknown;
	readonly title: string | null;
}

/**
 * THE SELLABILITY RULE (#109, #166) — a product can be sold only when it is live,
 * priced AND titled. The title belongs to the rule because an order line
 * SNAPSHOTS it (`createOrderFromCart`): a title-less product cannot be ordered, so
 * any surface that called it sellable was promising a checkout that fails at the
 * last step.
 *
 * Pure and IO-free, so every sell path asks the same question: the storefront's
 * `purchasable` (`joinProduct`), the add-to-cart guard, the checkout quote and
 * `createOrderFromCart`. The admin console mirrors it in
 * `@urumi.ai/otta-admin-presentation`'s `unsellableReasons`, and a plugin test
 * holds the two equal.
 *
 * Every missing piece is returned, not just the first, so a surface can say all
 * of why. An empty array means sellable.
 */
export function unsellableReasons(row: SellabilityFacts): UnsellableReason[] {
	if (row.deletedAt !== undefined && row.deletedAt !== null) return ["deleted"];
	const reasons: UnsellableReason[] = [];
	if (!row.active) reasons.push("unpublished");
	if (row.price === null || row.price === undefined) reasons.push("unpriced");
	// An empty (or non-string, off the wire) title is no title: there is no name
	// for an order line to snapshot.
	if (typeof row.title !== "string" || row.title === "") reasons.push("untitled");
	return reasons;
}

/** {@link unsellableReasons} is empty — narrowed so a caller can read the price
 *  and title it just proved present. */
export function isProductSellable<T extends SellabilityFacts>(
	row: T,
): row is T & { price: NonNullable<T["price"]>; title: string } {
	return unsellableReasons(row).length === 0;
}
