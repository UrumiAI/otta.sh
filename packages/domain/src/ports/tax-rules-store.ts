import type { TaxClassId } from "../pricing/types.js";

/**
 * `TaxRulesStore` (Phase 6 §6) — tax classes × zone → a single flat rate in
 * integer basis points, plus an optional per-rate "applies to shipping" flag.
 * Config data only; the pure engine (`computeLineTax`) never touches this store.
 */
export interface TaxRulesStore {
	createClass(input: CreateTaxClassInput): Promise<TaxClass>;
	listClasses(): Promise<TaxClass[]>;
	/**
	 * Delete a tax class from the registry (product data-model adds, Increment 2
	 * slice 5). Delete-in-use is FORBIDDEN at the store's OWN grain: a class still
	 * referenced by any `tax_rate` cannot be deleted (`in_use_by_rates`) — an
	 * atomic guard so a concurrent rate insert can never orphan a rate onto a
	 * just-deleted class. The PRODUCT-reference guard lives one level up in the
	 * `deleteTaxClass` use-case (via `ProductCommerceStore.countByTaxClass`),
	 * because product rows live in a different store aggregate; this method owns
	 * only the tax config it can see atomically.
	 *  - unknown id → `{ ok: false, reason: "not_found" }` (no-op; nothing deleted).
	 *  - referenced by ≥1 rate → `{ ok: false, reason: "in_use_by_rates" }` (no-op).
	 *  - otherwise → `{ ok: true }` (the class row is removed).
	 */
	deleteClass(id: TaxClassId): Promise<DeleteTaxClassStoreResult>;

	createRate(input: CreateTaxRateInput): Promise<TaxRate>;
	/** The rate for a (class, zone), or null (⇒ treated as 0 bps by the engine). */
	getRate(taxClassId: TaxClassId, zoneId: string): Promise<TaxRate | null>;
	/** Every tax rate in a zone — the checkout read that builds the pipeline's
	 *  `taxRatesByClass` map and identifies the shipping tax class. */
	listRatesForZone(zoneId: string): Promise<TaxRate[]>;
}

export interface TaxClass {
	id: TaxClassId;
	name: string;
}

export interface CreateTaxClassInput {
	id: TaxClassId;
	name: string;
}

/** Outcome of `TaxRulesStore.deleteClass` — the store's own-grain delete-in-use
 *  guard (rate references). The product-reference guard is added by the
 *  `deleteTaxClass` use-case, which widens this into its own result. */
export type DeleteTaxClassStoreResult =
	| { ok: true }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "in_use_by_rates" };

export interface TaxRate {
	id: string;
	taxClassId: TaxClassId;
	zoneId: string;
	/** Integer basis points, 0–10000 (0%–100%). */
	rateBps: number;
	/** Whether this class's rate is applied to the shipping fee in this zone. */
	appliesToShipping: boolean;
}

export interface CreateTaxRateInput {
	id: string;
	taxClassId: TaxClassId;
	zoneId: string;
	rateBps: number;
	appliesToShipping: boolean;
}
