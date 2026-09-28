import type { Money } from "../money/cents.js";
import type { ProductCommerce, ProductVariant } from "../ports/product-commerce-store.js";
import type { ProductId, Sku } from "../money/ids.js";

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

/**
 * What one cart line SELLS: the product itself, or one of its variants.
 *
 * A line is identified by (product, sku). The product's own sku sells the
 * product at its own price and title, exactly as before variants existed. Any
 * other sku must be a LIVE (not orphaned) variant of THAT product: it sells at
 * the variant's price, under the title snapshot `<product> — <variant>` (the
 * variant key standing in when the CMS gave the row no name). A sku that is
 * neither — someone else's, an orphaned size, a typo — is `null`, which every
 * caller answers as "this product does not sell that sku".
 *
 * Price and title are carried AS STORED, nulls included: the caller refuses a
 * null with its own token (`PRODUCT_NOT_PRICED`), after the product's liveness
 * (`isProductLive`, which gates its variants too). The tax class and the
 * fulfillment kind stay the product's — a variant carries neither.
 *
 * Pure and IO-free: the caller reads the product row and its variants (one
 * batch per request, `getManyVariantsByProductId`) and asks the same question
 * on every sell path — the add guard, the quote, the order, the summary, the
 * cart read.
 */
export interface SellableUnit {
	kind: "product" | "variant";
	sku: Sku;
	price: Money | null;
	title: string | null;
	/** The variant key when `kind` is `"variant"`, else null. */
	variantKey: string | null;
}

export function resolveSellableUnit(
	product: Pick<ProductCommerce, "sku" | "price" | "title">,
	variants: readonly Pick<
		ProductVariant,
		"variantKey" | "sku" | "price" | "title" | "orphanedAt"
	>[],
	sku: string,
): SellableUnit | null {
	if (product.sku !== null && String(product.sku) === sku) {
		return {
			kind: "product",
			sku: product.sku,
			price: product.price,
			title: product.title,
			variantKey: null,
		};
	}
	const variant = variants.find(
		(row) => row.orphanedAt === null && row.sku !== null && String(row.sku) === sku,
	);
	if (variant === undefined || variant.sku === null) return null;
	return {
		kind: "variant",
		sku: variant.sku,
		price: variant.price,
		title:
			product.title === null ? null : `${product.title} — ${variant.title ?? variant.variantKey}`,
		variantKey: variant.variantKey,
	};
}

/**
 * The products whose variants a set of lines needs: those with a line naming a
 * sku other than the product's own. A cart of product skus needs none, so its
 * sell path pays no variant read at all. Unknown products are left out — the
 * caller refuses their lines anyway.
 */
export function productsSellingVariants(
	lines: readonly { productId: string | null; sku: string }[],
	products: ReadonlyMap<ProductId, Pick<ProductCommerce, "sku">>,
): ProductId[] {
	const out = new Set<ProductId>();
	for (const line of lines) {
		if (line.productId === null) continue;
		const id = line.productId as ProductId;
		const row = products.get(id);
		if (row !== undefined && (row.sku === null || String(row.sku) !== line.sku)) out.add(id);
	}
	return [...out];
}
