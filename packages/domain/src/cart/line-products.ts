import { sku as toSku } from "../money/ids.js";
import type { ProductCommerceStore } from "../ports/product-commerce-store.js";

/**
 * Fill in the productId of every cart line that has none, from its sku (issue #111).
 *
 * A line added without a productId — a bare add, or a cart from before the
 * storefront threaded one — still carries its sku, and a live sku names exactly
 * one live product row. Every reader that prices a cart (the cart read, the
 * quote, the order) runs its lines through here first, so such a line is priced
 * and checked out by the same per-line checks as a threaded one, instead of
 * being refused PRODUCT_NOT_PRICED for a reference it never had.
 *
 * READ-ONLY: nothing is written back to the cart. A line whose sku no live
 * product row holds (deleted, renamed away, or a variant's sku — see
 * `ProductCommerceStore.getProductIdsBySku`) is returned unchanged, so it keeps
 * failing exactly as before. Lines that already carry a productId are never
 * re-pointed, and a cart with none missing costs no store read at all.
 */
export async function resolveLineProductIds<L extends { sku: string; productId: string | null }>(
	store: Pick<ProductCommerceStore, "getProductIdsBySku">,
	lines: readonly L[],
): Promise<L[]> {
	const missing = lines.filter((line) => line.productId === null).map((line) => toSku(line.sku));
	if (missing.length === 0) return [...lines];
	const bySku = await store.getProductIdsBySku(missing);
	return lines.map((line) => {
		if (line.productId !== null) return line;
		const found = bySku.get(toSku(line.sku));
		return found === undefined ? line : { ...line, productId: found };
	});
}
