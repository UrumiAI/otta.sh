import { type Cents, cents, type Currency } from "../money/cents.js";
import { computeQuote, type QuoteDeps, type QuoteFailure } from "./quote.js";
import { resolveShippingRate } from "./shipping.js";
import { resolveShippingZone, type ShippingDestination } from "./shipping-zones.js";
import type { ShippingMethodType, TotalsBreakdown, TotalsLineInput } from "./types.js";
import type { CouponValidationFailure } from "./validate-coupon.js";

/**
 * The checkout preview (issue #305): given a cart's priced lines and the
 * buyer's shipping ADDRESS, derive the shipping zone server-side, offer that
 * zone's methods at their price for this cart, validate the optional coupon,
 * and price the totals — shipping and tax — in the derived zone.
 *
 * THE BUYER NEVER CHOOSES A ZONE. There is no zone field on the command: the
 * zone comes from `resolveShippingZone(listZones(), destination)` and nowhere
 * else, and the same zone is the tax zone. The buyer picks only a METHOD, and
 * only from the derived zone's offered list — a method from anywhere else is
 * reported `SHIPPING_METHOD_NOT_AVAILABLE` and not charged.
 *
 * `selection` is the exact `{shippingZoneId, shippingMethodId, couponCode}` to
 * hand to `createOrderFromCart`, whose quote is the same `computeQuote` call on
 * the same inputs — so the order's totals equal this preview's by construction.
 *
 * Read-only: nothing is redeemed or written. Two deliberate non-refusals:
 *  - a store with NO zones at all is `not_configured` and keeps today's
 *    behaviour (no shipping, no tax) rather than refusing every physical order —
 *    the merchant has not set shipping up, and the caller says so honestly;
 *  - a digital-only cart (`requiresShipping: false`) needs no address or zone
 *    and is priced exactly as before (no shipping, no zone tax).
 */
export interface PreviewCheckoutCommand {
	currency: Currency;
	lines: ReadonlyArray<TotalsLineInput>;
	/** Whether any line ships (a physical product). */
	requiresShipping: boolean;
	/** The buyer's ship-to; absent ⇒ not entered yet. */
	destination?: ShippingDestination;
	/** The method the buyer picked, if any. */
	shippingMethodId?: string;
	couponCode?: string;
}

/** A method offered in the derived zone, priced for THIS cart. */
export interface OfferedShippingMethod {
	id: string;
	name: string;
	type: ShippingMethodType;
	/** What choosing it costs this cart (a free-shipping threshold already
	 *  judged against the discounted subtotal). */
	priceCents: Cents;
	/** The configured rate (the below-threshold fee for `free_shipping`). */
	rateCents: Cents;
	minSubtotalCents: Cents | null;
}

export type ShippingUnavailableReason = "NO_ZONE_FOR_ADDRESS" | "NO_METHOD_FOR_ZONE";

export type CheckoutShipping =
	| { status: "not_required" }
	| { status: "not_configured" }
	| { status: "address_required" }
	| { status: "unavailable"; reason: ShippingUnavailableReason }
	| {
			status: "resolved";
			zone: { id: string; name: string };
			methods: OfferedShippingMethod[];
			/** The picked method, when it is one of `methods`. */
			selectedMethodId: string | null;
			/** A method was picked that this zone does not offer. */
			selectionError: "SHIPPING_METHOD_NOT_AVAILABLE" | null;
	  };

export type CouponInvalidReason = "COUPON_NOT_FOUND" | CouponValidationFailure;

export type CheckoutCouponOutcome =
	| { status: "none" }
	| { status: "applied"; code: string; discountCents: Cents }
	| { status: "invalid"; code: string; reason: CouponInvalidReason };

export interface CheckoutSelection {
	shippingZoneId: string | null;
	shippingMethodId: string | null;
	couponCode: string | null;
}

export type PreviewCheckoutResult =
	| {
			ok: true;
			shipping: CheckoutShipping;
			coupon: CheckoutCouponOutcome;
			breakdown: TotalsBreakdown;
			selection: CheckoutSelection;
	  }
	| { ok: false; reason: QuoteFailure };

const COUPON_REASONS: ReadonlySet<QuoteFailure> = new Set<QuoteFailure>([
	"COUPON_NOT_FOUND",
	"COUPON_NOT_ACTIVE",
	"COUPON_MIN_SUBTOTAL",
	"COUPON_EXHAUSTED",
	"COUPON_CURRENCY_MISMATCH",
]);

function isCouponReason(reason: QuoteFailure): reason is CouponInvalidReason {
	return COUPON_REASONS.has(reason);
}

interface ZoneStep {
	shipping: CheckoutShipping;
	zoneId: string | null;
	methodId: string | null;
	/** Offered methods before per-cart pricing (rate + threshold only). */
	offered: Omit<OfferedShippingMethod, "priceCents">[];
}

/** A step that derived no zone: nothing to charge, nothing to tax in. */
function none(shipping: CheckoutShipping): ZoneStep {
	return { shipping, zoneId: null, methodId: null, offered: [] };
}

async function resolveZoneStep(
	deps: QuoteDeps,
	command: PreviewCheckoutCommand,
): Promise<ZoneStep> {
	if (!command.requiresShipping) return none({ status: "not_required" });
	const zones = await deps.shippingRules.listZones();
	if (zones.length === 0) return none({ status: "not_configured" });
	if (command.destination === undefined) return none({ status: "address_required" });

	const resolved = resolveShippingZone(zones, command.destination);
	if (!resolved.ok) return none({ status: "unavailable", reason: resolved.reason });
	const zone = resolved.zone;

	const offered: ZoneStep["offered"] = [];
	for (const method of await deps.shippingRules.listMethods(zone.id)) {
		const rate = await deps.shippingRules.getRate(method.id, command.currency);
		if (rate === null) continue; // never priced in this currency ⇒ not offered
		offered.push({
			id: method.id,
			name: method.name,
			type: method.type,
			rateCents: rate.amountCents,
			minSubtotalCents: rate.minSubtotalCents,
		});
	}
	offered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	if (offered.length === 0) return none({ status: "unavailable", reason: "NO_METHOD_FOR_ZONE" });

	const picked = command.shippingMethodId;
	const hasPick = picked !== undefined && picked !== "";
	const selected = hasPick ? (offered.find((m) => m.id === picked) ?? null) : null;
	return {
		shipping: {
			status: "resolved",
			zone: { id: zone.id, name: zone.name },
			methods: [],
			selectedMethodId: selected?.id ?? null,
			selectionError: hasPick && selected === null ? "SHIPPING_METHOD_NOT_AVAILABLE" : null,
		},
		zoneId: zone.id,
		methodId: selected?.id ?? null,
		offered,
	};
}

/** See the module doc. */
export async function previewCheckout(
	deps: QuoteDeps,
	command: PreviewCheckoutCommand,
): Promise<PreviewCheckoutResult> {
	const step = await resolveZoneStep(deps, command);

	const base = {
		currency: command.currency,
		lines: command.lines,
		...(step.zoneId !== null ? { zoneId: step.zoneId } : {}),
		...(step.methodId !== null ? { methodId: step.methodId } : {}),
	};
	const code = command.couponCode;
	const hasCoupon = code !== undefined && code !== "";

	let coupon: CheckoutCouponOutcome = { status: "none" };
	let quote = await computeQuote(deps, hasCoupon ? { ...base, couponCode: code } : base);
	if (!quote.ok && hasCoupon && isCouponReason(quote.reason)) {
		// An unusable coupon is reported, not fatal: the rest still prices.
		coupon = { status: "invalid", code, reason: quote.reason };
		quote = await computeQuote(deps, base);
	}
	if (!quote.ok) return { ok: false, reason: quote.reason };
	const breakdown = quote.breakdown;
	if (hasCoupon && coupon.status === "none") {
		coupon = { status: "applied", code, discountCents: breakdown.discountCents };
	}

	let shipping = step.shipping;
	if (shipping.status === "resolved") {
		const discounted = cents(breakdown.subtotalCents - breakdown.discountCents);
		const zoneId = shipping.zone.id;
		shipping = {
			...shipping,
			methods: step.offered.map((m) => ({
				...m,
				priceCents: resolveShippingRate(
					{
						zoneId,
						methodId: m.id,
						type: m.type,
						amountCents: m.rateCents,
						minSubtotalCents: m.minSubtotalCents,
					},
					discounted,
				),
			})),
		};
	}

	return {
		ok: true,
		shipping,
		coupon,
		breakdown,
		selection: {
			shippingZoneId: step.zoneId,
			shippingMethodId: step.methodId,
			couponCode: coupon.status === "applied" ? coupon.code : null,
		},
	};
}
