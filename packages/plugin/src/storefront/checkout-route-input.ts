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
import { COUPON_CODE_MAX, isIdToken } from "../commerce/commerce-input.js";
import type { ShippingAddressWire } from "../product-commerce/commerce-client.js";
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

/**
 * What the buyer chose to price the cart WITH (#305). Shared by the summary and
 * the place route, so the review and the order can never be priced from two
 * differently-parsed selections.
 *
 * There is deliberately no `shippingZoneId`: the tax zone is never the
 * client's to choose (a buyer who could pick one could pick a zero-tax one).
 * Neither parser reads it; PR 2 derives it from the ship-to address.
 */
export interface CheckoutSelection {
	/** Trimmed, case KEPT — coupon lookup is case-sensitive. */
	couponCode?: string;
	shippingMethodId?: string;
}

export interface CheckoutSummaryParsedInput {
	cartId: string;
	locale: string;
	selection: CheckoutSelection;
}

export interface CheckoutPlaceParsedInput {
	cartId: string;
	buyerRef: string;
	idempotencyKey: string;
	shippingAddress?: ShippingAddressWire;
	/** Display only — it formats the order total this route returns and reaches
	 *  no upstream call. Sanitized like the other routes' (a malformed tag falls
	 *  back rather than rejecting: a bad locale must not fail an order). */
	locale: string;
	selection: CheckoutSelection;
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

/** Absent, null or blank-after-trim ⇒ "not chosen" (a blank coupon field is
 *  how a buyer removes one). Anything else must be a string. */
function optionalString(value: unknown): string | undefined | null {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The selection, or `null` for INVALID_INPUT. Present-but-malformed is a
 * reject, never a silent drop — and it must be rejected HERE: the commerce
 * client THROWS on an over-long code or a malformed id, and a throw past this
 * point is the route guard's RENDER_FAILED, not a typed refusal.
 */
export function parseCheckoutSelection(input: {
	couponCode?: unknown;
	shippingMethodId?: unknown;
}): CheckoutSelection | null {
	const couponCode = optionalString(input.couponCode);
	const shippingMethodId = optionalString(input.shippingMethodId);
	if (couponCode === null || shippingMethodId === null) return null;
	if (couponCode !== undefined && couponCode.length > COUPON_CODE_MAX) return null;
	if (shippingMethodId !== undefined && !isIdToken(shippingMethodId)) return null;
	return {
		...(couponCode !== undefined ? { couponCode } : {}),
		...(shippingMethodId !== undefined ? { shippingMethodId } : {}),
	};
}

export function parseCheckoutSummaryInput(input: {
	cartId?: unknown;
	locale?: unknown;
	couponCode?: unknown;
	shippingMethodId?: unknown;
}): CheckoutSummaryParsedInput | null {
	const cartId = nonEmptyString(input.cartId);
	if (cartId === null) return null;
	const selection = parseCheckoutSelection(input);
	if (selection === null) return null;
	return { cartId, locale: sanitizeLocale(input.locale), selection };
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
	couponCode?: unknown;
	shippingMethodId?: unknown;
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
	const selection = parseCheckoutSelection(input);
	if (selection === null) return null;

	const parsed: CheckoutPlaceParsedInput = {
		cartId,
		buyerRef,
		idempotencyKey,
		locale: sanitizeLocale(input.locale),
		selection,
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
