/**
 * Pure pricing data model (Phase 6 §4). Everything here is plain, IO-free data:
 * `computeTotals` takes a `TotalsInput` (lines + a pre-fetched `RulesSnapshot` +
 * an optional pre-validated coupon) and returns a `TotalsBreakdown`, never
 * touching a store, clock, or network. Money is branded `Cents`; rates are
 * integer basis points (`bps`, 0–10000 = 0%–100%), never a float.
 */

import type { Cents, Currency } from "../money/cents.js";

/** A tax class identifier, e.g. `"standard" | "reduced" | "zero" | "digital"`. */
export type TaxClassId = string;

export type CouponType = "fixed_amount" | "percentage";

/** A flat amount off the subtotal, currency-bound and clamped at the subtotal. */
export interface FixedAmountCoupon {
	type: "fixed_amount";
	code: string;
	amountCents: Cents;
	/** Fixed-amount coupons are denominated — a currency mismatch is rejected. */
	currency: Currency;
}

/** A percentage off the subtotal (integer bps) with an optional cap. */
export interface PercentageCoupon {
	type: "percentage";
	code: string;
	/** Integer basis points, 0–10000 (0%–100%). */
	bps: number;
	/** Optional `maxDiscountCents`; null = uncapped. */
	capCents: Cents | null;
}

export type Coupon = FixedAmountCoupon | PercentageCoupon;

export type ShippingMethodType = "flat_rate" | "free_shipping";

/**
 * The resolved shipping method for the selected zone/method — plain snapshot
 * data fetched by the use-case before the pure engine runs.
 *
 * - `flat_rate`: `amountCents` is charged unconditionally.
 * - `free_shipping`: `0` once the discounted subtotal meets `minSubtotalCents`
 *   (or when `minSubtotalCents` is null); otherwise `amountCents` is the
 *   below-threshold fallback fee (0 = strictly free / unavailable).
 */
export interface ShippingMethodSnapshot {
	zoneId: string;
	methodId: string;
	type: ShippingMethodType;
	amountCents: Cents;
	minSubtotalCents: Cents | null;
}

/**
 * The pre-fetched rules the pure engine needs — no IO inside `computeTotals`.
 * `taxRatesByClass` maps a `TaxClassId` to its integer bps in the buyer's zone;
 * a class absent from the map is treated as `0` bps (untaxed).
 */
export interface RulesSnapshot {
	shippingMethod: ShippingMethodSnapshot;
	taxRatesByClass: Readonly<Record<TaxClassId, number>>;
	/** Whether the shipping fee is itself taxable in the buyer's zone (§ case 5). */
	shippingTaxable: boolean;
	/** The tax class used for the shipping-tax line when `shippingTaxable`. */
	shippingTaxClassId: TaxClassId;
}

/** A cart line the pipeline prices — unit price is the Phase-3/4 snapshot. */
export interface TotalsLineInput {
	unitPriceCents: Cents;
	qty: number;
	taxClassId: TaxClassId;
}

export interface TotalsInput {
	currency: Currency;
	lines: ReadonlyArray<TotalsLineInput>;
	/** Already validated/loaded (dates, min-subtotal, exhaustion) — pure data. */
	coupon?: Coupon;
	rules: RulesSnapshot;
}

/** Per-line detail feeding `order_totals.tax_breakdown` (§6). */
export interface TotalsLineBreakdown {
	taxClassId: TaxClassId;
	/** The line's share of the discounted subtotal (pro-rata, §4). */
	discountedCents: Cents;
	taxCents: Cents;
}

export interface TotalsBreakdown {
	currency: Currency;
	subtotalCents: Cents;
	discountCents: Cents;
	shippingCents: Cents;
	taxCents: Cents;
	totalCents: Cents;
	lineBreakdown: ReadonlyArray<TotalsLineBreakdown>;
	shippingTaxCents: Cents;
	appliedCouponCode?: string;
}
