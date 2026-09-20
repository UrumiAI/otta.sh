/**
 * The admin RULES surface — shipping (zones → methods → rates), tax (classes,
 * rates) and coupons (admin-UX Increment 3) — plus the wire-shaped types that
 * cross it. Covers the FULL rules surface: reads, creates, updates and deletes.
 * No UI is built here (the console pages consume this port).
 *
 * These types are defined LOCALLY and deliberately: this module NEVER imports
 * `@otta-sh/domain`, which keeps the plugin sandbox-clean (enforced by the
 * dependency-cruiser rule, MOD-4). Money is integer minor units + ISO-4217
 * currency throughout. The "wire" in the names is historical — it was once the
 * JSON shape of a separate commerce service — and it is still exactly the shape
 * the admin route's JSON responses use, so the name stays accurate.
 */

// -- Wire types (local; never `@otta-sh/domain`) --------------------------------

export interface ShippingZoneWire {
	id: string;
	name: string;
	regions: unknown;
}

export interface ShippingMethodWire {
	id: string;
	zoneId: string;
	name: string;
	/** 'flat_rate' | 'free_shipping'. */
	type: string;
}

export interface ShippingRateWire {
	methodId: string;
	currency: string;
	amountCents: number;
	minSubtotalCents: number | null;
}

export interface TaxClassWire {
	id: string;
	name: string;
}

export interface TaxRateWire {
	id: string;
	taxClassId: string;
	zoneId: string;
	rateBps: number;
	appliesToShipping: boolean;
}

/** The serialized coupon shape the admin routes emit (start/expiry are
 *  intentionally not serialized there, so they are absent here — the list row
 *  {@link CouponSummaryWire} carries them instead). */
export interface CouponWire {
	id: string;
	code: string;
	type: string;
	amountCents: number | null;
	rateBps: number | null;
	capCents: number | null;
	currency: string | null;
	minSubtotalCents: number | null;
	maxUses: number | null;
	maxUsesPerCustomer: number | null;
	usesCount: number;
}

/** One admin Coupons-list row (admin-UX Increment 3, view-only enumerate).
 *  The FULL coupon summary — every `CouponWire` field PLUS the validity
 *  window (`startsAt`/`expiresAt`, absent from `CouponWire` because
 *  `serializeCoupon` omits them) and `createdAt`: a small, header-only table
 *  has nothing expensive to trim off the list projection (unlike
 *  `ProductSummaryWire`, which deliberately narrows the full product row),
 *  and the console list renders the expiry column directly — no per-row
 *  detail fetch. `usesCount` doubles as the redeemed indicator (already a
 *  plain column, no join). */
export interface CouponSummaryWire {
	id: string;
	code: string;
	type: string;
	amountCents: number | null;
	rateBps: number | null;
	capCents: number | null;
	currency: string | null;
	minSubtotalCents: number | null;
	startsAt: string | null;
	expiresAt: string | null;
	maxUses: number | null;
	maxUsesPerCustomer: number | null;
	usesCount: number;
	createdAt: string;
}

/** The list filter the console builds from its filter form. `search` is the
 *  ONLY axis this slice ships (coupons have no soft-delete/publish-gate/kind
 *  axis to mirror `ProductsListFilter`'s `deleted`/`active`/`productKind`) —
 *  a case-insensitive EXACT match on `code`, never a substring. */
export interface CouponsListFilter {
	search?: string;
}

export interface CouponsListResult {
	coupons: CouponSummaryWire[];
	/** Opaque keyset cursor for the next page, or null on the last page. */
	nextCursor: string | null;
	/**
	 * Exact number of coupons matching the ACTIVE FILTER — the whole set, not
	 * this page (INC-23).
	 *
	 * OPTIONAL for one reason only: a service older than the field omits it, and
	 * a renderer must then fall back to the page-scoped count it always had
	 * ("25 coupons on this page"). Never defaulted to `0` — that would caption a
	 * page of rows with a count of none.
	 */
	total?: number;
}

// -- Discriminated results ----------------------------------------------------
// A failure NEVER throws into the host; it surfaces a typed reason the caller
// renders as GENERIC copy, never a raw HTTP status/URL.

/** Create outcome — success carries the created row; a failure carries the
 *  status the console keys its GENERIC copy off (never rendered raw). */
export type RulesCreateResult<T> = { ok: true; value: T } | { ok: false; status: number };

/** LWW-update outcome (zones, methods, coupons) — no `stale` (no CAS). */
export type RulesUpdateResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "error"; status: number };

/** CAS-update outcome (shipping/tax rates) — `stale` carries the fresh row so
 *  the caller can reload rather than blind-retry a losing edit. */
export type RulesCasUpdateResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "stale"; current: T | null }
	| { ok: false; reason: "error"; status: number };

/** Delete outcome. `in_use` is the referential-guard refusal (a zone with
 *  methods, a method with rates, a redeemed coupon); leaf-rate deletes never
 *  return it. `not_found` is the idempotent no-op. */
export type RulesDeleteResult =
	| { ok: true }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "in_use" }
	| { ok: false; reason: "error"; status: number };

/**
 * Tax-class delete outcome (Increment 3 closeout). A DEDICATED result type,
 * not the generic `RulesDeleteResult` — `deleteTaxClass`'s two in-use
 * reasons (product vs. rate references) each carry a `count`, so the console
 * can render an HONEST "N products/rates reference this class" instead of the
 * generic screens' bare "in use, delete the children first" copy.
 */
export type TaxClassDeleteResult =
	| { ok: true }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "in_use_by_products"; count: number }
	| { ok: false; reason: "in_use_by_rates"; count: number }
	| { ok: false; reason: "error"; status: number };

// -- Input shapes -------------------------------------------------------------

export interface ShippingZoneInput {
	id: string;
	name: string;
	regions?: unknown;
}
/** Full-replace edit — `regions` is REQUIRED (an omitted key is refused, so an
 *  edit can never silently wipe the zone's match list); send `null` to clear
 *  deliberately. */
export interface ShippingZoneEdit {
	name: string;
	regions: unknown;
}
export interface ShippingMethodInput {
	id: string;
	name: string;
	type: string;
}
export interface ShippingMethodEdit {
	name: string;
	type: string;
}
export interface ShippingRateInput {
	currency: string;
	amountCents: number;
	minSubtotalCents?: number | null;
}
/** Full-replace edit — `minSubtotalCents` is REQUIRED-nullable (an omitted key
 *  is refused, so an edit can never silently clear the free-shipping
 *  threshold); send `null` to clear deliberately. */
export interface ShippingRateEdit {
	amountCents: number;
	minSubtotalCents: number | null;
	/** The money-bearing CAS token — the amount the admin read on the detail. */
	expectedAmountCents: number;
}
export interface TaxClassInput {
	id: string;
	name: string;
}
/** Full-replace rename (LWW, no CAS — a class carries no money); `id` is
 *  immutable identity and is never sent (the path param addresses it). */
export interface TaxClassEdit {
	name: string;
}
export interface TaxRateInput {
	id: string;
	taxClassId: string;
	zoneId: string;
	rateBps: number;
	appliesToShipping?: boolean;
}
/** Full-replace edit — `appliesToShipping` is REQUIRED (an omitted key is
 *  refused, so an edit can never silently flip the shipping-tax behavior). */
export interface TaxRateEdit {
	rateBps: number;
	appliesToShipping: boolean;
	/** The money-bearing CAS token — the rate the admin read on the detail. */
	expectedRateBps: number;
}
export interface CouponInput {
	id: string;
	code: string;
	type: string;
	amountCents?: number | null;
	rateBps?: number | null;
	capCents?: number | null;
	currency?: string | null;
	minSubtotalCents?: number | null;
	startsAt?: string | null;
	expiresAt?: string | null;
	maxUses?: number | null;
	maxUsesPerCustomer?: number | null;
}
/** Coupon edit — `id`/`code`/`type`/`currency` are immutable identity/kind and
 *  are NOT sent (re-defining them is refused). */
export interface CouponEdit {
	amountCents?: number | null;
	rateBps?: number | null;
	capCents?: number | null;
	minSubtotalCents?: number | null;
	startsAt?: string | null;
	expiresAt?: string | null;
	maxUses?: number | null;
	maxUsesPerCustomer?: number | null;
}

/**
 * THE ADMIN RULES SURFACE, structurally — what a caller may do to shipping
 * zones/methods/rates, tax classes/rates and coupons, with no claim about how it
 * gets done.
 *
 * ONE implementation answers to this now (work order 02, INC-D3b):
 * `InProcessAdminRulesClient`, which composes this behaviour over the plugin's
 * own document store. The `ctx.http` client that used to be the second
 * implementation is gone with the commerce service it talked to, and with it the
 * reason this was a `Pick` over a nominal class rather than an interface — so it
 * is written out as an interface now, which is what it always described.
 *
 * EVERY METHOD IS LISTED, all twenty-five, and writing them out is still the
 * point: this is much the widest surface in the console, and one that listed
 * fewer would let a method be forgotten SILENTLY. A method added to the
 * in-process client without being declared here is not part of the surface, and
 * a method declared here that the client does not implement is a compile error.
 *
 * A failure NEVER throws into the host on a mutation; it surfaces a typed reason
 * the caller renders as GENERIC copy, never a raw status. Reads that cannot
 * answer still throw — the caller degrades that section rather than the page.
 */
export interface AdminRulesSurface {
	// -- Shipping: zones -------------------------------------------------------

	listZones(): Promise<ShippingZoneWire[]>;
	createZone(input: ShippingZoneInput): Promise<RulesCreateResult<ShippingZoneWire>>;
	updateZone(zoneId: string, edit: ShippingZoneEdit): Promise<RulesUpdateResult<ShippingZoneWire>>;
	deleteZone(zoneId: string): Promise<RulesDeleteResult>;

	// -- Shipping: methods -----------------------------------------------------

	listMethods(zoneId: string): Promise<ShippingMethodWire[]>;
	createMethod(
		zoneId: string,
		input: ShippingMethodInput,
	): Promise<RulesCreateResult<ShippingMethodWire>>;
	updateMethod(
		methodId: string,
		edit: ShippingMethodEdit,
	): Promise<RulesUpdateResult<ShippingMethodWire>>;
	deleteMethod(methodId: string): Promise<RulesDeleteResult>;

	// -- Shipping: rates -------------------------------------------------------

	/** Read one method's rate in a currency; a rate that does not exist resolves
	 *  to `null` rather than throwing. */
	getRate(methodId: string, currency: string): Promise<ShippingRateWire | null>;
	createRate(
		methodId: string,
		input: ShippingRateInput,
	): Promise<RulesCreateResult<ShippingRateWire>>;
	/** CAS on the money the admin read (`edit.expectedAmountCents`) — a losing
	 *  edit comes back `stale` WITH the fresh row, never applied blind. */
	updateRate(
		methodId: string,
		currency: string,
		edit: ShippingRateEdit,
	): Promise<RulesCasUpdateResult<ShippingRateWire>>;
	deleteRate(methodId: string, currency: string): Promise<RulesDeleteResult>;

	// -- Tax: classes ----------------------------------------------------------

	listTaxClasses(): Promise<TaxClassWire[]>;
	createTaxClass(input: TaxClassInput): Promise<RulesCreateResult<TaxClassWire>>;
	updateTaxClass(classId: string, edit: TaxClassEdit): Promise<RulesUpdateResult<TaxClassWire>>;
	/** Delete a tax class. A DEDICATED result type, not the generic
	 *  `RulesDeleteResult`: the two in-use refusals each carry a `count` this
	 *  method surfaces, unlike the generic zone/method/coupon deletes. */
	deleteTaxClass(classId: string): Promise<TaxClassDeleteResult>;

	// -- Tax: rates ------------------------------------------------------------

	listTaxRates(zoneId: string): Promise<TaxRateWire[]>;
	createTaxRate(input: TaxRateInput): Promise<RulesCreateResult<TaxRateWire>>;
	/** CAS on the rate the admin read (`edit.expectedRateBps`) — a losing edit
	 *  comes back `stale` WITH the fresh row, never applied blind. */
	updateTaxRate(rateId: string, edit: TaxRateEdit): Promise<RulesCasUpdateResult<TaxRateWire>>;
	deleteTaxRate(rateId: string): Promise<RulesDeleteResult>;

	// -- Coupons ---------------------------------------------------------------

	/**
	 * Read the admin Coupons console list (admin-UX Increment 3, view-only
	 * enumerate). Pass EITHER a fresh `filter` OR a previous page's `opts.cursor`
	 * — never both: the cursor already embeds the active filter, so a filter
	 * alongside it could disagree with what the token re-derives.
	 */
	listCoupons(
		filter: CouponsListFilter,
		opts?: { cursor?: string; limit?: number },
	): Promise<CouponsListResult>;
	/** Read one coupon by CODE; a coupon that does not exist resolves to `null`. */
	getCoupon(code: string): Promise<CouponWire | null>;
	createCoupon(input: CouponInput): Promise<RulesCreateResult<CouponWire>>;
	updateCoupon(couponId: string, edit: CouponEdit): Promise<RulesUpdateResult<CouponWire>>;
	deleteCoupon(couponId: string): Promise<RulesDeleteResult>;
}
