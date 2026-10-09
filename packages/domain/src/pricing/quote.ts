import { type Cents, cents, type Currency } from "../money/cents.js";
import { currencyPaymentIncrement } from "../money/currencies.js";
import { ORDER_ADDRESS_MAX_LENGTHS } from "../orders/order-address.js";
import type { Clock } from "../ports/clock.js";
import type { CouponRecord, CouponStore } from "../ports/coupon-store.js";
import type { SettingsStore } from "../ports/settings-store.js";
import type { ShippingRulesStore } from "../ports/shipping-rules-store.js";
import type { TaxRulesStore } from "../ports/tax-rules-store.js";
import {
	assembleTotals,
	computePreTax,
	type PreTaxTotals,
	taxRequestLinesOf,
} from "./compute-totals.js";
import { createRateTableCalculator } from "./rate-table-calculator.js";
import {
	effectiveTaxSettings,
	TAX_DISABLED_CALCULATOR_ID,
	type TaxSettings,
} from "./tax-settings.js";
import { normalizeCountryCode, normalizeSubdivision } from "./region-codes.js";
import { roundHalfUpToMultiple } from "./round.js";
import {
	DEFAULT_TAX_CALCULATOR_TIMEOUT_MS,
	isValidCalculatorId,
	type TaxAddress,
	type TaxCalculator,
	type TaxRequest,
	type TaxResult,
} from "./tax-calculator.js";
import type { Coupon, RulesSnapshot, TotalsBreakdown, TotalsLineInput } from "./types.js";
import { validateTaxResult } from "./validate-tax-result.js";
import { type CouponValidationFailure, validateCoupon } from "./validate-coupon.js";
import { resolveShippingZone, type ZoneDestination, type ZoneResolution } from "./zone-match.js";

export interface QuoteDeps {
	shippingRules: ShippingRulesStore;
	taxRules: TaxRulesStore;
	couponStore: CouponStore;
	clock: Clock;
	/**
	 * A registered outside calculator (ADR-0030). Absent ⇒ the built-in
	 * `otta.rate-table` over `taxRules`, which never refuses. An outside one
	 * that throws, refuses, answers invalidly or exceeds
	 * {@link taxCalculatorTimeoutMs} fails the quote with `TAX_UNAVAILABLE`.
	 */
	taxCalculator?: TaxCalculator;
	/** Defaults to {@link DEFAULT_TAX_CALCULATOR_TIMEOUT_MS}. */
	taxCalculatorTimeoutMs?: number;
	/**
	 * Where the store's tax options are read (ADR-0032). Absent ⇒ "nothing saved",
	 * so the upgrade rule applies (`effectiveTaxSettings`).
	 */
	settings?: Pick<SettingsStore, "get">;
}

/** Why the quote is being made — passed to the calculator as `purpose`. */
export interface QuoteContext {
	purpose: "quote" | "order";
}

export interface QuoteCommand {
	currency: Currency;
	lines: ReadonlyArray<TotalsLineInput>;
	/**
	 * Whether any line ships (ADR-0021 Decision 5). A digital-only cart ignores
	 * the destination entirely — it is never priced by it and never refused on
	 * zone grounds — and refuses a shipping method.
	 */
	requiresShipping: boolean;
	/**
	 * Where the order ships. The zone — and so the tax — is DERIVED from it;
	 * there is deliberately no way to pass a zone (ADR-0021 Decision 1).
	 * Validated here with the same rules as the order's address.
	 */
	destination?: {
		country: string;
		region?: string | null;
		/** For calculators that price by postcode/city (ADR-0030); zones do not read them. */
		postalCode?: string | null;
		city?: string | null;
	};
	/** The selected shipping method; absent ⇒ zero shipping (no method chosen). */
	methodId?: string;
	couponCode?: string;
}

/** The tax part of a quote: who priced it, the answer, and whether prices included it. */
export interface QuoteTax {
	calculatorId: string;
	result: TaxResult;
	pricesIncludeTax: boolean;
}

export type QuoteFailure =
	/** The destination's country is not an ISO 3166-1 alpha-2 code. */
	| "INVALID_SHIPPING_ADDRESS"
	/** The destination's region is not a real subdivision code of its country,
	 *  or is blank where the country has a subdivision-level zone. */
	| "SHIPPING_REGION_CODE_REQUIRED"
	/** Zones exist and the destination matches none of them. */
	| "SHIPPING_ZONE_NOT_MATCHED"
	/** A method was chosen for a physical cart, but there is no destination. */
	| "MISSING_SHIPPING_ADDRESS"
	| "SHIPPING_METHOD_NOT_FOUND"
	/** The method does not belong to the zone the destination matched. */
	| "SHIPPING_METHOD_NOT_IN_ZONE"
	/** A method was chosen for a cart with nothing to ship. */
	| "SHIPPING_METHOD_NOT_APPLICABLE"
	| "SHIPPING_RATE_NOT_FOUND"
	| "COUPON_NOT_FOUND"
	| CouponValidationFailure
	/** An outside tax calculator could not answer (ADR-0030). Never the built-in. */
	| "TAX_UNAVAILABLE";

export type QuoteResult =
	| {
			ok: true;
			breakdown: TotalsBreakdown;
			couponRecord: CouponRecord | null;
			/** How the zone was resolved — `matched` names the zone that priced
			 *  the shipping and the tax. */
			destination: ZoneResolution;
			/** The calculator's validated answer, for the order's frozen snapshot. */
			tax: QuoteTax;
			/** The tax options this quote was priced under (after the upgrade rule). */
			taxSettings: TaxSettings;
			/** Whether a tax location matched a zone — false ⇒ the tax was not located. */
			taxLocated: boolean;
	  }
	| { ok: false; reason: QuoteFailure };

/**
 * The read-side checkout preview (Phase 6 §6): load the shipping rules and
 * validate the coupon via the store ports, price the pre-tax totals, then ask
 * the tax calculator (ADR-0030) — the ONE place tax is calculated, reused by
 * `/checkout/quote` (read-only, no redemption) and by `createOrderFromCart`
 * (which additionally redeems). It never mutates anything.
 *
 * ORDER MATTERS, and the plugin's checkout summary bounds its fallback
 * re-quotes on it (plugin storefront/checkout-routes.ts): destination →
 * zone → method → rate → coupon → tax. Tax is LAST, so every other refusal
 * comes first and costs no calculator call.
 */
export async function computeQuote(
	deps: QuoteDeps,
	command: QuoteCommand,
	context: QuoteContext = { purpose: "quote" },
): Promise<QuoteResult> {
	const subtotal = sumLineSubtotals(command.lines);

	// 1. The destination, normalised with the SAME rules as the order address.
	//    A digital-only cart's destination is ignored entirely (Decision 5).
	let destination: ZoneDestination | undefined;
	let taxDestination: TaxAddress | null = null;
	if (command.requiresShipping && command.destination !== undefined) {
		const country = normalizeCountryCode(command.destination.country);
		if (country === null) return { ok: false, reason: "INVALID_SHIPPING_ADDRESS" };
		const region = normalizeSubdivision(country, command.destination.region);
		if (!region.ok) return { ok: false, reason: "SHIPPING_REGION_CODE_REQUIRED" };
		const postalCode = boundedOrNull(
			command.destination.postalCode,
			ORDER_ADDRESS_MAX_LENGTHS.postalCode,
		);
		const city = boundedOrNull(command.destination.city, ORDER_ADDRESS_MAX_LENGTHS.city);
		if (postalCode === false || city === false) {
			return { ok: false, reason: "INVALID_SHIPPING_ADDRESS" };
		}
		destination = { country, region: region.code };
		taxDestination = { country, region: region.code, postalCode, city };
	}

	// 2. The zone. A digital-only cart needs none, so it reads none.
	const zones = command.requiresShipping ? await deps.shippingRules.listZones() : [];
	const resolution = resolveShippingZone(zones, {
		requiresShipping: command.requiresShipping,
		...(destination !== undefined ? { destination } : {}),
	});
	if (resolution.status === "unmatched") return { ok: false, reason: "SHIPPING_ZONE_NOT_MATCHED" };
	if (resolution.status === "region_code_required") {
		return { ok: false, reason: "SHIPPING_REGION_CODE_REQUIRED" };
	}
	const zoneId = resolution.status === "matched" ? resolution.zoneId : null;

	// 3–4. The method, which must belong to the matched zone, and its rate;
	//    absent ⇒ the zero-shipping synthetic method (no method chosen — the
	//    pipeline still runs, never the naive Phase-4 stub sum).
	let shippingMethod: RulesSnapshot["shippingMethod"];
	// Whether the chosen method's charge is taxed at all (PR 2b; WooCommerce's
	// `is_taxable()`). The zero-shipping synthetic method has nothing to tax.
	let shippingTaxable = false;
	if (command.methodId !== undefined && command.methodId !== "") {
		if (resolution.status === "not_required") {
			return { ok: false, reason: "SHIPPING_METHOD_NOT_APPLICABLE" };
		}
		if (resolution.status === "address_needed") {
			return { ok: false, reason: "MISSING_SHIPPING_ADDRESS" };
		}
		const method = await deps.shippingRules.getMethod(command.methodId);
		if (method === null) return { ok: false, reason: "SHIPPING_METHOD_NOT_FOUND" };
		// With no zones configured an existing method is an ORPHAN: it belongs to
		// no zone an address can match, so it is never priced.
		if (method.zoneId !== zoneId) return { ok: false, reason: "SHIPPING_METHOD_NOT_IN_ZONE" };
		const rate = await deps.shippingRules.getRate(command.methodId, command.currency);
		if (rate === null) return { ok: false, reason: "SHIPPING_RATE_NOT_FOUND" };
		shippingMethod = {
			zoneId: method.zoneId,
			methodId: method.id,
			type: method.type,
			amountCents: rate.amountCents,
			minSubtotalCents: rate.minSubtotalCents,
		};
		shippingTaxable = method.taxable !== false;
	} else {
		shippingMethod = {
			zoneId: zoneId ?? "",
			methodId: "",
			type: "flat_rate",
			amountCents: cents(0),
			minSubtotalCents: null,
		};
	}

	// 5. Coupon: load + validate (dates, min-subtotal, currency, soft-exhaustion).
	// The last check on the buyer's selection — see the ORDER MATTERS note above.
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

	// 6. Pre-tax totals: subtotal → discount → discounted lines → shipping fee.
	const preTax = computePreTax({
		currency: command.currency,
		lines: command.lines,
		...(coupon !== undefined ? { coupon } : {}),
		shippingMethod,
	});

	// 7. Tax — the ONE calculator call (ADR-0030), after every refusal above,
	//    so a refused quote never costs a paid outside call. The store's tax
	//    options (ADR-0032) decide whether it is asked at all and for where.
	const taxSettings = await loadTaxSettings(deps);
	const lines = taxRequestLinesOf(preTax, command.requiresShipping);
	if (!taxSettings.enabled) {
		const tax: QuoteTax = {
			calculatorId: TAX_DISABLED_CALCULATOR_ID,
			pricesIncludeTax: false,
			result: {
				ok: true,
				currency: command.currency,
				lines: lines.map((l) => ({
					lineId: l.lineId,
					rateBps: 0,
					label: "Tax",
					taxCents: cents(0),
				})),
				shipping: null,
			},
		};
		const breakdown = assembleTotals(preTax, tax.result);
		return {
			ok: true,
			breakdown,
			couponRecord,
			destination: resolution,
			tax,
			taxSettings,
			taxLocated: false,
		};
	}
	const located = await taxLocationOf(deps, taxSettings, command.requiresShipping, zones, {
		address: taxDestination,
		zoneId,
	});
	const base = taxSettings.baseAddress;
	const request = freezeRequest({
		purpose: context.purpose,
		currency: command.currency,
		pricesIncludeTax: taxSettings.pricesIncludeTax,
		lines,
		// A method that is not taxable is asked about as no shipping at all: the
		// built-in then taxes none, and an outside calculator that taxes it anyway
		// is refused by the validator (fail-closed).
		shipping: shippingTaxable
			? { amountCents: preTax.shippingCents, methodId: shippingMethod.methodId }
			: null,
		origin: base === null ? null : { ...base, postalCode: null, city: null },
		destination: located.address,
		zoneId: located.zoneId,
	});
	const calculated = await calculateTax(deps, request, preTax, taxSettings);
	if (calculated === null) return { ok: false, reason: "TAX_UNAVAILABLE" };
	const tax: QuoteTax = { ...calculated, pricesIncludeTax: taxSettings.pricesIncludeTax };
	const breakdown = assembleTotals(preTax, tax.result, tax.pricesIncludeTax);
	return {
		ok: true,
		breakdown,
		couponRecord,
		destination: resolution,
		tax,
		taxSettings,
		taxLocated: located.zoneId !== null,
	};
}

/**
 * The saved tax options, or — nothing saved — the upgrade rule's answer. A
 * registered outside calculator counts as "this store already charges tax" just
 * as a rate table does: such a store has no rates (the calculator replaces
 * them), and before ADR-0032 its calculator priced every quote — reading it as a
 * new store would switch tax off and silently stop asking the calculator.
 */
async function loadTaxSettings(deps: QuoteDeps): Promise<TaxSettings> {
	const saved = deps.settings === undefined ? undefined : (await deps.settings.get()).tax;
	if (saved !== undefined) return saved;
	if (deps.taxCalculator !== undefined) return effectiveTaxSettings(undefined, true);
	return effectiveTaxSettings(undefined, await deps.taxRules.hasAnyRate());
}

interface TaxLocation {
	address: TaxAddress | null;
	zoneId: string | null;
}

/**
 * Where tax is charged (ADR-0032): the shop's base address for a digital-only
 * cart, or when the settings say "based on shop base address"; otherwise the
 * ship-to and the zone it already matched. With NO base address set, a
 * digital-only cart stays unlocated — and so untaxed, exactly as before — and
 * "base" falls back to the ship-to. A base address no zone matches is located
 * nowhere: no rate ⇒ 0%, never a refusal.
 */
async function taxLocationOf(
	deps: QuoteDeps,
	settings: TaxSettings,
	requiresShipping: boolean,
	zonesRead: Awaited<ReturnType<ShippingRulesStore["listZones"]>>,
	shipTo: TaxLocation,
): Promise<TaxLocation> {
	const base = settings.baseAddress;
	const useBase = base !== null && (!requiresShipping || settings.basedOn === "base");
	if (!useBase) return requiresShipping ? shipTo : { address: null, zoneId: null };
	const zones = requiresShipping ? zonesRead : await deps.shippingRules.listZones();
	const matched = resolveShippingZone(zones, {
		requiresShipping: true,
		destination: { country: base.country, region: base.region },
	});
	return {
		address: { country: base.country, region: base.region, postalCode: null, city: null },
		zoneId: matched.status === "matched" ? matched.zoneId : null,
	};
}

/** Trimmed text, `null` when absent/blank, `false` when over `max` (the order address's bounds). */
function boundedOrNull(value: string | null | undefined, max: number): string | null | false {
	const trimmed = value?.trim() ?? "";
	if (trimmed === "") return null;
	return trimmed.length > max ? false : trimmed;
}

/** The request is handed to code Otta does not own: freeze it, so the answer
 *  is validated against exactly what was asked. */
function freezeRequest(request: TaxRequest): TaxRequest {
	for (const line of request.lines) Object.freeze(line);
	Object.freeze(request.lines);
	if (request.shipping !== null) Object.freeze(request.shipping);
	if (request.destination !== null) Object.freeze(request.destination);
	return Object.freeze(request);
}

/**
 * Ask the calculator. The built-in cannot fail on valid rules — an invalid
 * answer from it is a programming error and THROWS. An outside one is fenced:
 * a throw, a refusal, an invalid answer or the timeout is `null`
 * (`TAX_UNAVAILABLE`), logged by calculator id and reason, never by address.
 */
async function calculateTax(
	deps: QuoteDeps,
	request: TaxRequest,
	preTax: PreTaxTotals,
	settings: TaxSettings,
): Promise<{ calculatorId: string; result: TaxResult } | null> {
	const outside = deps.taxCalculator;
	if (outside === undefined) {
		const builtIn = createRateTableCalculator(deps.taxRules, {
			shippingTaxClass: settings.shippingTaxClass,
			roundAtSubtotal: settings.roundAtSubtotal,
		});
		const result = validateTaxResult(request, await builtIn.calculate(request), {
			boundTaxToAmount: false,
		});
		if (result === null) throw new Error(`${builtIn.id} produced an invalid tax result`);
		return { calculatorId: builtIn.id, result };
	}

	let id: unknown;
	try {
		id = outside.id;
	} catch {
		id = undefined;
	}
	if (!isValidCalculatorId(id)) return refuse("<invalid id>", "has an invalid id");
	let raw: unknown;
	try {
		raw = await withTimeout(
			() => outside.calculate(request),
			deps.taxCalculatorTimeoutMs ?? DEFAULT_TAX_CALCULATOR_TIMEOUT_MS,
		);
	} catch (err) {
		return refuse(id, err === TIMED_OUT ? "timed out" : "threw");
	}
	// Reading the answer runs ITS code too (a getter, a Proxy trap), so every
	// read stays inside the fence; the validated copy holds only primitives.
	try {
		if (typeof raw === "object" && raw !== null && (raw as { ok?: unknown }).ok === false) {
			return refuse(id, "refused");
		}
		const result = validateTaxResult(request, raw);
		if (result === null) return refuse(id, "answered invalidly");
		// A tax that is safe on its own may still overflow the ORDER total, which
		// `assembleTotals` would throw on — refuse it here instead.
		if (!Number.isSafeInteger(orderTotalOf(preTax, result, request.pricesIncludeTax))) {
			return refuse(id, "answered a tax that overflows the order total");
		}
		return { calculatorId: id, result };
	} catch {
		return refuse(id, "answered invalidly");
	}
}

/** `assembleTotals`' grand total, as an unchecked number. */
function orderTotalOf(preTax: PreTaxTotals, result: TaxResult, pricesIncludeTax: boolean): number {
	const shippingTax = result.shipping?.taxCents ?? 0;
	const tax = pricesIncludeTax
		? shippingTax
		: result.lines.reduce((sum, l) => sum + l.taxCents, shippingTax);
	const exact = preTax.subtotalCents - preTax.discountCents + preTax.shippingCents + tax;
	// The total `assembleTotals` brands is the ROUNDED one for an increment
	// currency, so the fence checks that too.
	const increment = currencyPaymentIncrement(preTax.currency);
	return increment === undefined || !Number.isSafeInteger(exact)
		? exact
		: roundHalfUpToMultiple(exact, increment);
}

function refuse(id: string, why: string): null {
	// `console` is an ambient global, not an IO import (see create-order-from-cart's
	// logIntentFailure). No request data is logged: it carries the buyer's address.
	console.warn(`[domain] tax calculator ${JSON.stringify(id)} ${why} → TAX_UNAVAILABLE`);
	return null;
}

const TIMED_OUT: unique symbol = Symbol("tax calculator timed out");

/** Settles with `run()`'s outcome, or rejects with {@link TIMED_OUT} after `ms`;
 *  the timer is always cleared. A synchronous throw from `run` rejects too. */
async function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			new Promise<T>((resolve, reject) => {
				// The handler is attached SYNCHRONOUSLY: an already-rejected promise
				// adopted a microtask later is reported as unhandled by workerd.
				try {
					Promise.resolve(run()).then(resolve, reject);
				} catch (err) {
					reject(err);
				}
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(TIMED_OUT), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Convenience: subtotal of a line set (integer minor units). */
export function sumLineSubtotals(lines: ReadonlyArray<TotalsLineInput>): Cents {
	return cents(lines.reduce((sum, l) => sum + l.unitPriceCents * l.qty, 0));
}
