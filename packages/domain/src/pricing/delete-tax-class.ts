import type { ProductCommerceStore } from "../ports/product-commerce-store.js";
import type { TaxClassId } from "./types.js";
import type { TaxRulesStore } from "../ports/tax-rules-store.js";

export interface DeleteTaxClassDeps {
	taxRules: TaxRulesStore;
	productCommerce: ProductCommerceStore;
}

/**
 * Outcome of `deleteTaxClass` — a discriminated union so the caller renders each
 * case without status-code-as-logic. `in_use_by_products` and `in_use_by_rates`
 * are the two delete-in-use refusals (the cross-aggregate product guard and the
 * store's own-grain rate guard); `not_found` is an unknown id.
 */
export type DeleteTaxClassResult =
	| { ok: true }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "in_use_by_products" }
	| { ok: false; reason: "in_use_by_rates" };

/**
 * Delete a tax class from the registry with a DELETE-IN-USE guard spanning both
 * aggregates that can reference it (product data-model adds, Increment 2 slice
 * 5). A tax class is the referent of two independent things — merchant products
 * (`product_commerce.tax_class`) and tax rates (`tax_rates.tax_class_id`) — that
 * live in separate store aggregates, so the guard is composed here rather than
 * buried in one adapter:
 *
 *  1. If any LIVE product still references the class → `in_use_by_products`
 *     (checked FIRST: a product dangling on a deleted class would silently fall
 *     back to `"standard"` tax at the next checkout — a money-affecting
 *     regression, the failure the merchant most needs protected).
 *  2. Otherwise delegate to `TaxRulesStore.deleteClass`, whose atomic guard
 *     refuses if a `tax_rate` references the class (`in_use_by_rates`) and
 *     reports `not_found` for an unknown id.
 *
 * NOTE the deliberate TOCTOU window between the product count and the store
 * delete: a product could be re-pointed at the class in the gap. This is
 * ACCEPTED for an admin-console registry-maintenance action (not a checkout hot
 * path) — the worst case is a class deleted moments after a product adopted it,
 * healed by the merchant re-selecting a class on that product; the no-oversell
 * class of invariant is not involved. A single-statement cross-aggregate guard
 * is not available (the two live in different store aggregates), and inventing a
 * distributed lock for a rare maintenance action would be over-engineering.
 *
 * There is intentionally NO service endpoint for this in THIS slice — the tax
 * rules admin surface is Increment 3's scope. This use-case + its supporting
 * store primitives ship now (contract-tested) so Increment 3 builds on a proven
 * guard rather than reinventing it.
 */
export async function deleteTaxClass(
	deps: DeleteTaxClassDeps,
	id: TaxClassId,
): Promise<DeleteTaxClassResult> {
	const productRefs = await deps.productCommerce.countByTaxClass(id);
	if (productRefs > 0) {
		return { ok: false, reason: "in_use_by_products" };
	}
	const res = await deps.taxRules.deleteClass(id);
	if (res.ok) return { ok: true };
	return { ok: false, reason: res.reason };
}
