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

	/**
	 * Guarded EDIT of a tax rate's money-bearing config (admin-UX Increment 3 —
	 * the tax/shipping admin's missing UPDATE capability). Only the RATE
	 * (`rateBps`) and the shipping-tax flag (`appliesToShipping`) are editable; a
	 * rate's `(taxClassId, zoneId)` identity is immutable (re-pointing a rate at a
	 * different class/zone is a create+delete, not an edit).
	 *
	 * OPTIMISTIC COMPARE-AND-SET on the money-bearing `rate_bps` (`expectedRateBps`
	 * = the rate the admin read on the detail): the atomic UPDATE is conditioned on
	 * `rate_bps = expectedRateBps`, so a concurrent admin edit that already moved
	 * the rate surfaces as `stale` (carrying the current row to reload) rather than
	 * silently CLOBBERING a rate change — a wrong tax rate is a money-affecting
	 * regression, so `rate_bps` is CAS-guarded (CLAUDE.md money discipline). A
	 * blind replay of an applied edit is therefore reported `stale`, never
	 * double-applied (once-only under replay). `appliesToShipping` rides along
	 * last-writer-wins within the winning update (a boolean flag, not money).
	 *  - unknown `id` → `not_found` (no row minted; an edit is not a create).
	 *  - `rate_bps != expectedRateBps` → `stale`, carrying the current row.
	 *  - otherwise → applies + returns the updated row.
	 */
	updateRate(
		id: string,
		input: UpdateTaxRateInput,
		expectedRateBps: number,
	): Promise<UpdateTaxRateResult>;

	/**
	 * Delete a tax RATE (a leaf — nothing references a rate row). Idempotent:
	 * deleting an unknown/already-deleted id is a `not_found` no-op, never an
	 * error (replay-safe). SNAPSHOT INVARIANT: an order snapshots its totals into
	 * `order_totals` at creation, so deleting a rate NEVER retroactively changes an
	 * existing order; an in-flight cart simply recomputes on its next
	 * quote/checkout and sees the rate gone (`getRate` → null ⇒ the pure engine
	 * treats the class as 0 bps — `computeTotals`' `taxRatesByClass[id] ?? 0`).
	 */
	deleteRate(id: string): Promise<DeleteTaxRateResult>;
}

export interface UpdateTaxRateInput {
	/** Integer basis points, 0–10000 (0%–100%). */
	rateBps: number;
	appliesToShipping: boolean;
}

/** Outcome of `updateRate` — a discriminated union so the caller renders each
 *  case without status-code-as-logic (mirrors `ProductCommerceUpdateResult`). */
export type UpdateTaxRateResult =
	| { ok: true; rate: TaxRate }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "stale"; current: TaxRate };

/** Outcome of `deleteRate` — a leaf delete with no referential guard. */
export type DeleteTaxRateResult = { ok: true } | { ok: false; reason: "not_found" };

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
