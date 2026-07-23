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
 * store's own-grain rate guard), each carrying the referencing `count` so the
 * admin surface can render an HONEST refusal ("N products/rates reference this
 * class") instead of a bare boolean (Increment 3 closeout); `not_found` is an
 * unknown id.
 */
export type DeleteTaxClassResult =
	| { ok: true }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "in_use_by_products"; count: number }
	| { ok: false; reason: "in_use_by_rates"; count: number };

/**
 * Delete a tax class from the registry with a DELETE-IN-USE guard spanning both
 * aggregates that can reference it (product data-model adds, Increment 2 slice
 * 5). A tax class is the referent of two independent things — merchant products
 * (`product_commerce.tax_class`) and tax rates (`tax_rates.tax_class_id`) — that
 * live in separate store aggregates, so the guard is composed here rather than
 * buried in one adapter:
 *
 *  1. If any LIVE product still references the class → `in_use_by_products`
 *     (checked FIRST: a product dangling on a deleted class would be silently
 *     UNTAXED at the next checkout — `computeTotals` treats a `taxClassId`
 *     absent from `taxRatesByClass` as 0 bps (`rules.taxRatesByClass[id] ?? 0`),
 *     and once the class's rates are gone the dangling id can never resolve a
 *     rate again. Charging no tax where tax is owed is a compliance-grade,
 *     money-affecting regression — the failure the merchant most needs
 *     protected. NOTE: the `?? "standard"` fallback in the checkout paths
 *     applies only to a NULL `taxClass`, never to a dangling id.)
 *  2. Otherwise delegate to `TaxRulesStore.deleteClass`, whose atomic guard
 *     refuses if a `tax_rate` references the class (`in_use_by_rates`) and
 *     reports `not_found` for an unknown id.
 *
 * NOTE the deliberate TOCTOU window between the product count and the store
 * delete: a product could be re-pointed at the class in the gap. This is
 * ACCEPTED for an admin-console registry-maintenance action (not a checkout hot
 * path) — the worst case is a class deleted moments after a product adopted it,
 * leaving that product's lines UNTAXED (0 bps, per the `?? 0` above) until the
 * merchant re-selects a class on it; the no-oversell class of invariant is not
 * involved. A single-statement cross-aggregate guard
 * is not available (the two live in different store aggregates), and inventing a
 * distributed lock for a rare maintenance action would be over-engineering.
 *
 * WIRED to `DELETE /admin/tax/classes/:id` (Increment 3 closeout — the #72
 * gap-audit finding: this use-case shipped contract-tested in Increment 2
 * slice 5 with no service route at all). The 409 refusal carries a `count` on
 * both in-use reasons (queried only on the refusal path, never the success
 * path) so the admin console can render an honest "N products/rates
 * reference this class" instead of a bare boolean.
 */
export async function deleteTaxClass(
	deps: DeleteTaxClassDeps,
	id: TaxClassId,
): Promise<DeleteTaxClassResult> {
	const productRefs = await deps.productCommerce.countByTaxClass(id);
	if (productRefs > 0) {
		return { ok: false, reason: "in_use_by_products", count: productRefs };
	}
	const res = await deps.taxRules.deleteClass(id);
	if (res.ok) return { ok: true };
	if (res.reason === "not_found") return { ok: false, reason: "not_found" };
	// in_use_by_rates: the atomic guard only knows "≥1" (an EXISTS); fetch the
	// honest count for the message on this rare refusal path.
	const rateRefs = await deps.taxRules.countRatesByClass(id);
	return { ok: false, reason: "in_use_by_rates", count: rateRefs };
}
