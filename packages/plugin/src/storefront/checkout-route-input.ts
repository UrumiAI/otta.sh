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
import type {
	ShippingAddressWire,
	ShippingDestinationWire,
} from "../product-commerce/commerce-client.js";
import { sanitizeLocale } from "./route-input.js";

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

/** A shipping-method id: the commerce client's id-token rule (printable ASCII,
 *  no whitespace, ≤200), checked here so a bad one is INVALID_INPUT and never a
 *  RENDER_FAILED from deeper in. */
const METHOD_ID = /^[\x21-\x7e]{1,200}$/;

/** `couponCode` — the quote's own `1..200` bound, after trimming. */
const COUPON_CODE_MAX = 200;

/** The optional checkout selections both routes take (issue #305). There is
 *  deliberately NO zone field: the zone is derived from the address. */
export interface CheckoutSelectionInput {
	shippingMethodId?: string;
	couponCode?: string;
}

export interface CheckoutSummaryParsedInput extends CheckoutSelectionInput {
	cartId: string;
	locale: string;
	/** Only the fields zone derivation reads — the summary is shown before the
	 *  buyer has typed a full address. */
	destination?: ShippingDestinationWire;
}

export interface CheckoutPlaceParsedInput extends CheckoutSelectionInput {
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

/**
 * The two optional selections. Blank (what an untouched form field submits) is
 * ABSENT; a present value that breaks its bound is a reject, never a drop — a
 * silently dropped coupon would price an order the buyer did not ask for.
 */
function parseSelection(input: {
	shippingMethodId?: unknown;
	couponCode?: unknown;
}): CheckoutSelectionInput | null {
	const out: CheckoutSelectionInput = {};
	const method = optionalString(input.shippingMethodId);
	if (method === null) return null;
	if (method !== undefined) {
		if (!METHOD_ID.test(method)) return null;
		out.shippingMethodId = method;
	}
	const coupon = optionalString(input.couponCode);
	if (coupon === null) return null;
	if (coupon !== undefined) {
		if (coupon.length > COUPON_CODE_MAX) return null;
		out.couponCode = coupon;
	}
	return out;
}

/** undefined ⇒ absent (missing, null or blank); null ⇒ a non-string (reject). */
function optionalString(value: unknown): string | undefined | null {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The summary's destination: the address's `country` (required when an address
 * is sent at all) and optional `region`, with the ship-to's own bounds. Other
 * address fields may ride along (the page posts the whole form) and are ignored
 * here — the summary prices, it does not capture. A BLANK country is "not
 * entered yet" (`undefined`), not a reject: the review page renders before the
 * buyer has picked one.
 */
export function parseShippingDestination(
	value: unknown,
): ShippingDestinationWire | undefined | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const country = optionalString(raw.country);
	if (country === null || (country !== undefined && country.length > ADDRESS_FIELDS.country.max)) {
		return null;
	}
	if (country === undefined) return undefined;
	const region = optionalString(raw.region);
	if (region === null || (region !== undefined && region.length > ADDRESS_FIELDS.region.max)) {
		return null;
	}
	return region === undefined ? { country } : { country, region };
}

export function parseCheckoutSummaryInput(input: {
	cartId?: unknown;
	locale?: unknown;
	shippingAddress?: unknown;
	shippingMethodId?: unknown;
	couponCode?: unknown;
}): CheckoutSummaryParsedInput | null {
	const cartId = nonEmptyString(input.cartId);
	if (cartId === null) return null;
	const selection = parseSelection(input);
	if (selection === null) return null;
	const parsed: CheckoutSummaryParsedInput = {
		cartId,
		locale: sanitizeLocale(input.locale),
		...selection,
	};
	if (input.shippingAddress !== undefined && input.shippingAddress !== null) {
		const destination = parseShippingDestination(input.shippingAddress);
		if (destination === null) return null;
		if (destination !== undefined) parsed.destination = destination;
	}
	return parsed;
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
	shippingMethodId?: unknown;
	couponCode?: unknown;
	locale?: unknown;
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

	const selection = parseSelection(input);
	if (selection === null) return null;

	const parsed: CheckoutPlaceParsedInput = {
		cartId,
		buyerRef,
		idempotencyKey,
		locale: sanitizeLocale(input.locale),
		...selection,
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
