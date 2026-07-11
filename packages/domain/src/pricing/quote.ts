import { type Cents, cents, type Currency } from "../money/cents.js";
import type { Clock } from "../ports/clock.js";
import type { CouponRecord, CouponStore } from "../ports/coupon-store.js";
import type { ShippingRulesStore } from "../ports/shipping-rules-store.js";
import type { TaxRulesStore } from "../ports/tax-rules-store.js";
import { computeTotals } from "./compute-totals.js";
import type { Coupon, RulesSnapshot, TotalsBreakdown, TotalsLineInput } from "./types.js";
import { type CouponValidationFailure, validateCoupon } from "./validate-coupon.js";

export interface QuoteDeps {
	shippingRules: ShippingRulesStore;
	taxRules: TaxRulesStore;
	couponStore: CouponStore;
	clock: Clock;
}

export interface QuoteCommand {
	currency: Currency;
	lines: ReadonlyArray<TotalsLineInput>;
	/** The buyer's tax zone; absent ⇒ no tax rates apply (all classes 0 bps). */
	zoneId?: string;
	/** The selected shipping method; absent ⇒ zero shipping (no method chosen). */
	methodId?: string;
	couponCode?: string;
}

export type QuoteFailure =
	| "SHIPPING_METHOD_NOT_FOUND"
	| "SHIPPING_RATE_NOT_FOUND"
	| "COUPON_NOT_FOUND"
	| CouponValidationFailure;

export type QuoteResult =
	| { ok: true; breakdown: TotalsBreakdown; couponRecord: CouponRecord | null }
	| { ok: false; reason: QuoteFailure };

/**
 * The read-side checkout preview (Phase 6 §6): load the shipping/tax rules and
 * validate the coupon via the store ports, then hand PURE data to `computeTotals`.
 * This is the single place IO meets the engine — reused by `/checkout/quote`
 * (read-only, no redemption) and by `createOrderFromCart` (which additionally
 * redeems). It never mutates anything.
 */
export async function computeQuote(deps: QuoteDeps, command: QuoteCommand): Promise<QuoteResult> {
	const subtotal = cents(command.lines.reduce((sum, l) => sum + l.unitPriceCents * l.qty, 0));

	// Shipping: resolve the selected method + its rate; absent ⇒ zero-shipping
	// synthetic method (no method chosen — the pipeline still runs, never the
	// naive Phase-4 stub sum).
	let shippingMethod: RulesSnapshot["shippingMethod"];
	if (command.methodId !== undefined && command.methodId !== "") {
		const method = await deps.shippingRules.getMethod(command.methodId);
		if (method === null) return { ok: false, reason: "SHIPPING_METHOD_NOT_FOUND" };
		const rate = await deps.shippingRules.getRate(command.methodId, command.currency);
		if (rate === null) return { ok: false, reason: "SHIPPING_RATE_NOT_FOUND" };
		shippingMethod = {
			zoneId: method.zoneId,
			methodId: method.id,
			type: method.type,
			amountCents: rate.amountCents,
			minSubtotalCents: rate.minSubtotalCents,
		};
	} else {
		shippingMethod = {
			zoneId: command.zoneId ?? "",
			methodId: "",
			type: "flat_rate",
			amountCents: cents(0),
			minSubtotalCents: null,
		};
	}

	// Tax: all rates in the zone → the per-class map + the shipping-tax class.
	const taxRatesByClass: Record<string, number> = {};
	let shippingTaxable = false;
	let shippingTaxClassId = "standard";
	if (command.zoneId !== undefined && command.zoneId !== "") {
		const zoneRates = await deps.taxRules.listRatesForZone(command.zoneId);
		for (const r of zoneRates) {
			taxRatesByClass[r.taxClassId] = r.rateBps;
			if (r.appliesToShipping) {
				shippingTaxable = true;
				shippingTaxClassId = r.taxClassId;
			}
		}
	}

	const rules: RulesSnapshot = {
		shippingMethod,
		taxRatesByClass,
		shippingTaxable,
		shippingTaxClassId,
	};

	// Coupon: load + validate (dates, min-subtotal, currency, soft-exhaustion).
	let couponRecord: CouponRecord | null = null;
	let coupon: Coupon | undefined;
	if (command.couponCode !== undefined && command.couponCode !== "") {
		couponRecord = await deps.couponStore.findByCode(command.couponCode);
		if (couponRecord === null) return { ok: false, reason: "COUPON_NOT_FOUND" };
		const validation = validateCoupon(couponRecord, {
			now: deps.clock.now().toISOString(),
			subtotalCents: subtotal,
			currency: command.currency,
		});
		if (!validation.ok) return { ok: false, reason: validation.reason };
		coupon = validation.coupon;
	}

	const breakdown = computeTotals({
		currency: command.currency,
		lines: command.lines,
		...(coupon !== undefined ? { coupon } : {}),
		rules,
	});
	return { ok: true, breakdown, couponRecord };
}

/** Convenience: subtotal of a line set (integer minor units). */
export function sumLineSubtotals(lines: ReadonlyArray<TotalsLineInput>): Cents {
	return cents(lines.reduce((sum, l) => sum + l.unitPriceCents * l.qty, 0));
}
