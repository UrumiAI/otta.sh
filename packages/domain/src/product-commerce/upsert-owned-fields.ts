import type { Money } from "../money/cents.js";
import type { Sku } from "../money/ids.js";
import type { ProductKind } from "../ports/product-commerce-store.js";

/**
 * The row fields `ProductCommerceStore.upsert` can write — the facts about the
 * product, as opposed to the sync bookkeeping (`idempotencyKey`,
 * `contentUpdatedAt`) the same write also stamps.
 *
 * `titleRejection` is optional because a stored document from before #112 has
 * none; it reads as `null`.
 */
export interface UpsertOwnedFields {
	readonly sku: Sku | null;
	readonly price: Money | null;
	readonly title: string | null;
	readonly titleRejection?: string | null;
	readonly taxClass: string | null;
	readonly weightGrams: number | null;
	readonly lengthMm: number | null;
	readonly widthMm: number | null;
	readonly heightMm: number | null;
	readonly productKind: ProductKind;
}

function sameMoney(a: Money | null, b: Money | null): boolean {
	if (a === null || b === null) return a === b;
	return a.amount === b.amount && a.currency === b.currency;
}

/**
 * Whether an applying upsert changed anything the row owns (issue #153). One
 * function so every store moves `updatedAt` on the same rule.
 *
 * `updatedAt` is the compare-and-set watermark an open admin edit form carries,
 * so it moves only when one of these fields does. A CMS save that changes no
 * owned field (a description edit, an image swap: the sync re-sends the same
 * title) still APPLIES — its `contentUpdatedAt` and replay key are stamped, so
 * ordering and once-only replay are untouched — but it leaves the watermark
 * where it was, and the form stays saveable.
 */
export function upsertChangesOwnedFields(
	before: UpsertOwnedFields,
	after: UpsertOwnedFields,
): boolean {
	return (
		before.sku !== after.sku ||
		!sameMoney(before.price, after.price) ||
		before.title !== after.title ||
		(before.titleRejection ?? null) !== (after.titleRejection ?? null) ||
		before.taxClass !== after.taxClass ||
		before.weightGrams !== after.weightGrams ||
		before.lengthMm !== after.lengthMm ||
		before.widthMm !== after.widthMm ||
		before.heightMm !== after.heightMm ||
		before.productKind !== after.productKind
	);
}
