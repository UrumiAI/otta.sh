import type { Cents, Currency } from "../money/cents.js";
import type { ShippingMethodType } from "../pricing/types.js";

/**
 * `ShippingRulesStore` (Phase 6 §6) — zone → method → flat rate config, plus the
 * checkout-time read the totals pipeline needs. All config data; the pure engine
 * (`resolveShippingRate`) never touches this store.
 *
 * Admin CRUD (create/list/get) mirrors the REST surface 1:1; `getRate` /
 * `resolveMethod` are the checkout reads.
 */
export interface ShippingRulesStore {
	createZone(input: CreateShippingZoneInput): Promise<ShippingZone>;
	listZones(): Promise<ShippingZone[]>;
	getZone(zoneId: string): Promise<ShippingZone | null>;

	/**
	 * Edit a zone's structural config (admin-UX Increment 3 — the missing UPDATE
	 * capability). `name`/`regions` only; a zone's `id` is its immutable identity.
	 * DELIBERATELY LAST-WRITER-WINS (no CAS): a zone carries NO money — a rename or
	 * region-list tweak is a structural, low-contention admin action, and the
	 * accepted `upsert`-style lost-update semantics (a second admin's rename wins)
	 * are harmless here (no money invariant, no oversell). Naturally idempotent — a
	 * replayed identical edit re-sets the same values. Unknown `id` → `not_found`
	 * (an edit is not a create; no row minted).
	 */
	updateZone(zoneId: string, input: UpdateShippingZoneInput): Promise<UpdateShippingZoneResult>;
	/**
	 * Delete a zone with a FORBID-IF-CHILDREN referential guard (mirrors
	 * `TaxRulesStore.deleteClass`'s own-grain guard): a zone that still has ≥1
	 * shipping method cannot be deleted (`in_use_by_methods`) — an ATOMIC guard
	 * (the DELETE is conditioned on no child method) so a concurrent method insert
	 * can never orphan a method onto a just-deleted zone. Cascade is deliberately
	 * NOT chosen: silently deleting a zone's methods (and their rates) would erase
	 * priced config a merchant may still want; forbid-then-let-the-admin-clear is
	 * the safe, reversible choice for a rare maintenance action. Idempotent:
	 * unknown id → `not_found` no-op.
	 */
	deleteZone(zoneId: string): Promise<DeleteShippingZoneResult>;

	createMethod(input: CreateShippingMethodInput): Promise<ShippingMethod>;
	listMethods(zoneId: string): Promise<ShippingMethod[]>;
	getMethod(methodId: string): Promise<ShippingMethod | null>;

	/**
	 * Edit a method's structural config (name, type). LAST-WRITER-WINS for the same
	 * reason as `updateZone` — a method carries no money; its rate does. A method's
	 * `id` and owning `zoneId` are immutable identity (moving a method between zones
	 * is a create+delete). Idempotent; unknown `id` → `not_found`.
	 */
	updateMethod(
		methodId: string,
		input: UpdateShippingMethodInput,
	): Promise<UpdateShippingMethodResult>;
	/**
	 * Delete a method with a FORBID-IF-CHILDREN guard: a method that still has ≥1
	 * rate cannot be deleted (`in_use_by_rates`) — atomic, mirroring `deleteZone`.
	 * Idempotent: unknown id → `not_found`.
	 */
	deleteMethod(methodId: string): Promise<DeleteShippingMethodResult>;

	createRate(input: CreateShippingRateInput): Promise<ShippingRate>;
	/** The rate for a method in a currency, or null. */
	getRate(methodId: string, currency: Currency): Promise<ShippingRate | null>;

	/**
	 * Guarded EDIT of a shipping rate's money-bearing config (admin-UX Increment
	 * 3). Keyed by the rate's `(methodId, currency)` identity (its primary key);
	 * `amountCents` (the shipping price) and `minSubtotalCents` (the free-shipping
	 * threshold) are editable.
	 *
	 * OPTIMISTIC COMPARE-AND-SET on the money-bearing `amount_cents`
	 * (`expectedAmountCents` = the price the admin read): the atomic UPDATE is
	 * conditioned on `amount_cents = expectedAmountCents`, so a concurrent edit
	 * that already moved the price surfaces as `stale` (reload) rather than a
	 * silent clobber — a wrong shipping fee is money-affecting (CLAUDE.md). A blind
	 * replay is reported `stale`, never double-applied. `minSubtotalCents` rides
	 * along last-writer-wins within the winning update (a threshold, not the fee).
	 *  - unknown `(methodId, currency)` → `not_found`.
	 *  - `amount_cents != expectedAmountCents` → `stale`, carrying the current row.
	 *  - otherwise → applies + returns the updated row.
	 */
	updateRate(
		methodId: string,
		currency: Currency,
		input: UpdateShippingRateInput,
		expectedAmountCents: Cents,
	): Promise<UpdateShippingRateResult>;
	/**
	 * Delete a shipping rate (a leaf). Idempotent: unknown `(methodId, currency)` →
	 * `not_found` no-op. SNAPSHOT INVARIANT: identical to `TaxRulesStore.deleteRate`
	 * — an order's totals are snapshotted at creation, so deletion never rewrites
	 * an existing order; an in-flight cart recomputes on next quote/checkout
	 * (a method with no rate resolves to unavailable/zero at that point).
	 */
	deleteRate(methodId: string, currency: Currency): Promise<DeleteShippingRateResult>;
}

export interface UpdateShippingZoneInput {
	name: string;
	regions: unknown;
}

export interface UpdateShippingMethodInput {
	name: string;
	type: ShippingMethodType;
}

export interface UpdateShippingRateInput {
	amountCents: Cents;
	minSubtotalCents: Cents | null;
}

/** LWW update outcomes — no `stale` (no CAS on structural, money-free rows). */
export type UpdateShippingZoneResult =
	| { ok: true; zone: ShippingZone }
	| { ok: false; reason: "not_found" };

export type UpdateShippingMethodResult =
	| { ok: true; method: ShippingMethod }
	| { ok: false; reason: "not_found" };

/** CAS update outcome — `stale` when the money-bearing `amount_cents` moved. */
export type UpdateShippingRateResult =
	| { ok: true; rate: ShippingRate }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "stale"; current: ShippingRate };

/** Delete outcomes — a referential guard for the parent rows, a bare no-op for
 *  the leaf rate. */
export type DeleteShippingZoneResult =
	| { ok: true }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "in_use_by_methods" };

export type DeleteShippingMethodResult =
	| { ok: true }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "in_use_by_rates" };

export type DeleteShippingRateResult = { ok: true } | { ok: false; reason: "not_found" };

export interface ShippingZone {
	id: string;
	name: string;
	/** Country/state/postal match list — opaque config the engine never reads. */
	regions: unknown;
}

export interface CreateShippingZoneInput {
	id: string;
	name: string;
	regions: unknown;
}

export interface ShippingMethod {
	id: string;
	zoneId: string;
	name: string;
	type: ShippingMethodType;
}

export interface CreateShippingMethodInput {
	id: string;
	zoneId: string;
	name: string;
	type: ShippingMethodType;
}

export interface ShippingRate {
	methodId: string;
	currency: Currency;
	amountCents: Cents;
	/** Free-shipping threshold; null = none. */
	minSubtotalCents: Cents | null;
}

export interface CreateShippingRateInput {
	methodId: string;
	currency: Currency;
	amountCents: Cents;
	minSubtotalCents: Cents | null;
}
