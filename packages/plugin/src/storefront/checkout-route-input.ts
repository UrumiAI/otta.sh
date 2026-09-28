/**
 * Boundary validation for the PUBLIC checkout routes (route-input.ts's style —
 * hand-rolled, no schema library in the plugin, because the routes are
 * reachable by anything that can POST to `/_emdash/api/plugins/otta/...`).
 *
 * Everything here runs BEFORE any commerce-client call: a garbage body must
 * never become an in-process round trip, and certainly never an order. Bounds
 * mirror the `checkoutBody` / `shippingAddressBody` schemas the standalone
 * `@otta-sh/service` used to enforce before it was folded into the plugin, so
 * a request this layer accepts is one the commerce client will not reject on
 * shape — it re-validates regardless.
 *
 * `buyerRef` is checked for LENGTH only, never for format: the service
 * documents it as an "email/session claim token", and the *site* owns the
 * plausible-email guard (it is the layer that knows the value came from a
 * checkout form rather than a session). See `sites/staging/src/lib/email.ts`.
 * What this layer must never do is REWRITE it — the service stores `buyer_ref`
 * verbatim and ADR-0004's guest-order claiming matches on it.
 */
import type { ShippingAddressWire } from "../product-commerce/commerce-client.js";
import { sanitizeLocale } from "./route-input.js";

/** The id-token bound the commerce client re-applies (`requireIdToken`):
 *  printable ASCII, no whitespace, at most 200 characters. */
const ID_TOKEN = /^[\x21-\x7e]{1,200}$/;
/** `requireBoundedText("couponCode", …, 1, 200)` in the commerce client. */
const COUPON_CODE_MAX = 200;

/** `checkoutBody.buyerRef` — `z.string().min(1).max(320)`. */
const BUYER_REF_MAX = 320;

/** `shippingAddressBody`'s bounds, verbatim. `undefined` max ⇒ optional field. */
const ADDRESS_FIELDS = {
	name: { max: 200, required: true },
	line1: { max: 200, required: true },
	line2: { max: 200, required: false },
	city: { max: 120, required: true },
	region: { max: 120, required: false },
	postalCode: { max: 32, required: true },
	country: { max: 100, required: true },
	email: { max: 320, required: false },
	phone: { max: 64, required: false },
} as const satisfies Record<keyof ShippingAddressWire, { max: number; required: boolean }>;

/**
 * The storefront's pricing choices (issue #305). All optional: a storefront that
 * offers no shipping picker or coupon field sends none, and the quote computes
 * exactly what it did before. When a method is sent and a zone is not, the domain
 * takes the tax zone from the method (`computeQuote`).
 */
export interface CheckoutPricingChoices {
	shippingZoneId?: string;
	shippingMethodId?: string;
	couponCode?: string;
}

export interface CheckoutSummaryParsedInput extends CheckoutPricingChoices {
	cartId: string;
	locale: string;
}

export interface CheckoutPlaceParsedInput extends CheckoutPricingChoices {
	cartId: string;
	buyerRef: string;
	idempotencyKey: string;
	shippingAddress?: ShippingAddressWire;
	/** Display only — it formats the order total this route returns and reaches
	 *  no upstream call. Sanitized like the other routes' (a malformed tag falls
	 *  back rather than rejecting: a bad locale must not fail an order). */
	locale: string;
}

export interface OrderRouteParsedInput {
	orderId: string;
	locale: string;
}

function nonEmptyString(value: unknown, max = 200): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/** Absent, null or blank ⇒ not chosen (`undefined`); present-but-malformed ⇒
 *  `null`, a reject — a choice the buyer made is never silently dropped, or the
 *  order would be charged without the coupon or the delivery they picked. */
function optionalChoice(value: unknown, valid: (v: string) => boolean): string | undefined | null {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	return valid(trimmed) ? trimmed : null;
}

function parsePricingChoices(input: {
	shippingZoneId?: unknown;
	shippingMethodId?: unknown;
	couponCode?: unknown;
}): CheckoutPricingChoices | null {
	const isIdToken = (v: string) => ID_TOKEN.test(v);
	const shippingZoneId = optionalChoice(input.shippingZoneId, isIdToken);
	const shippingMethodId = optionalChoice(input.shippingMethodId, isIdToken);
	const couponCode = optionalChoice(input.couponCode, (v) => v.length <= COUPON_CODE_MAX);
	if (shippingZoneId === null || shippingMethodId === null || couponCode === null) return null;
	return {
		...(shippingZoneId !== undefined ? { shippingZoneId } : {}),
		...(shippingMethodId !== undefined ? { shippingMethodId } : {}),
		...(couponCode !== undefined ? { couponCode } : {}),
	};
}

export function parseCheckoutSummaryInput(input: {
	cartId?: unknown;
	locale?: unknown;
	shippingZoneId?: unknown;
	shippingMethodId?: unknown;
	couponCode?: unknown;
}): CheckoutSummaryParsedInput | null {
	const cartId = nonEmptyString(input.cartId);
	if (cartId === null) return null;
	const choices = parsePricingChoices(input);
	if (choices === null) return null;
	return { cartId, locale: sanitizeLocale(input.locale), ...choices };
}

export function parseOrderRouteInput(input: {
	orderId?: unknown;
	locale?: unknown;
}): OrderRouteParsedInput | null {
	const orderId = nonEmptyString(input.orderId);
	if (orderId === null) return null;
	return { orderId, locale: sanitizeLocale(input.locale) };
}

export function parseCheckoutPlaceInput(input: {
	cartId?: unknown;
	buyerRef?: unknown;
	idempotencyKey?: unknown;
	shippingAddress?: unknown;
	locale?: unknown;
	shippingZoneId?: unknown;
	shippingMethodId?: unknown;
	couponCode?: unknown;
}): CheckoutPlaceParsedInput | null {
	const cartId = nonEmptyString(input.cartId);
	// Trimmed, but NOT otherwise rewritten — never lowercased (§1.5): the
	// service stores buyer_ref verbatim and claiming is already
	// case-insensitive, so normalizing would silently alter the buyer's own
	// identifier for no gain.
	const buyerRef = nonEmptyString(input.buyerRef, BUYER_REF_MAX);
	// The key arrives from the caller and is forwarded verbatim; the route
	// NEVER invents one (a fresh key per attempt mints a second order).
	const idempotencyKey = nonEmptyString(input.idempotencyKey);
	if (cartId === null || buyerRef === null || idempotencyKey === null) return null;
	const choices = parsePricingChoices(input);
	if (choices === null) return null;

	const parsed: CheckoutPlaceParsedInput = {
		cartId,
		buyerRef,
		idempotencyKey,
		locale: sanitizeLocale(input.locale),
		...choices,
	};

	if (input.shippingAddress !== undefined) {
		const address = parseShippingAddress(input.shippingAddress);
		if (address === null) return null;
		parsed.shippingAddress = address;
	}
	return parsed;
}

/**
 * ADR-0009's optional ship-to. Present-but-malformed is a REJECT, never a
 * silent drop: an order that quietly loses its delivery address is
 * unfulfillable and immutable (no self-service repair — ADR-0008's admin refund
 * is the only exit).
 */
export function parseShippingAddress(value: unknown): ShippingAddressWire | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const out: Record<string, string> = {};

	for (const [field, spec] of Object.entries(ADDRESS_FIELDS)) {
		const provided = raw[field];
		if (provided === undefined || provided === null || provided === "") {
			if (spec.required) return null;
			continue;
		}
		if (typeof provided !== "string") return null;
		const trimmed = provided.trim();
		if (trimmed.length > spec.max) return null;
		if (trimmed.length === 0) {
			// A required field of pure whitespace is a reject; an optional one is
			// simply absent (matching the site form's "blank means not given").
			if (spec.required) return null;
			continue;
		}
		out[field] = trimmed;
	}
	return out as unknown as ShippingAddressWire;
}
