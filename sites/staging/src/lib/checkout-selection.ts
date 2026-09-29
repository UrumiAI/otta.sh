/**
 * The `otta_checkout_selection` cookie — what the buyer has chosen so far on
 * the review page (issue #305): the destination COUNTRY and REGION, the
 * shipping method and the coupon code.
 *
 * WHY A COOKIE. The review page has no client JS, so "change the country and
 * see the delivery options and totals update" is a normal form round trip:
 * `POST /checkout/update` (origin-guarded) stores the selection here and 303s
 * back to `GET /checkout`, which hands it to `storefront/checkout/summary`.
 * A query string would work too, but would put a coupon code and the buyer's
 * state in browser history and access logs — the exposure `place.ts` already
 * refuses for the address. Only these four short fields travel; the street
 * address never does.
 *
 * WHAT IT IS NOT. It is not trusted for money: the plugin derives the shipping
 * zone from the country/region itself and re-checks the method against that
 * zone, both on the summary and again at place. A tampered cookie can at worst
 * pick a method the zone refuses, which the page reports.
 *
 * `path=/checkout` — only the review page, the update endpoint and the place
 * endpoint read it. It is cleared when a new cart is started.
 */
import type { CookieDeleter, CookieReader, CookieWriter } from "./checkout-cookie.js";

export const CHECKOUT_SELECTION_COOKIE_NAME = "otta_checkout_selection";
export const CHECKOUT_SELECTION_COOKIE_PATH = "/checkout";
/** A day: long enough to survive a coffee break, short enough to forget. */
export const CHECKOUT_SELECTION_MAX_AGE_SECONDS = 86_400;

export interface CheckoutSelection {
	/** ISO 3166-1 alpha-2, upper-cased. */
	country?: string;
	/** State / province as typed (e.g. `CA`). */
	region?: string;
	shippingMethodId?: string;
	couponCode?: string;
}

const COUNTRY = /^[A-Z]{2}$/;
/** The plugin's id-token rule: printable ASCII, no whitespace, ≤200. */
const METHOD_ID = /^[\x21-\x7e]{1,200}$/;
const REGION_MAX = 120;
const COUPON_MAX = 200;

function text(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

/**
 * Normalise raw values (a form post or a parsed cookie) into a selection.
 * Anything malformed is DROPPED, never forwarded: a value the plugin would
 * refuse as INVALID_INPUT would otherwise bounce the buyer off the review page.
 */
export function normalizeSelection(raw: Record<string, unknown>): CheckoutSelection {
	const out: CheckoutSelection = {};
	const country = text(raw.country, 2)?.toUpperCase();
	if (country !== undefined && COUNTRY.test(country)) out.country = country;
	const region = text(raw.region, REGION_MAX);
	if (region !== undefined && out.country !== undefined) out.region = region;
	const method = text(raw.shippingMethodId, 200);
	if (method !== undefined && METHOD_ID.test(method)) out.shippingMethodId = method;
	const coupon = text(raw.couponCode, COUPON_MAX);
	if (coupon !== undefined) out.couponCode = coupon;
	return out;
}

export function readCheckoutSelection(cookies: CookieReader): CheckoutSelection {
	const raw = cookies.get(CHECKOUT_SELECTION_COOKIE_NAME)?.value;
	if (raw === undefined || raw.length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return normalizeSelection(parsed as Record<string, unknown>);
	} catch {
		return {};
	}
}

export function setCheckoutSelection(cookies: CookieWriter, selection: CheckoutSelection): void {
	cookies.set(CHECKOUT_SELECTION_COOKIE_NAME, JSON.stringify(selection), {
		httpOnly: true,
		secure: true,
		sameSite: "lax",
		path: CHECKOUT_SELECTION_COOKIE_PATH,
		maxAge: CHECKOUT_SELECTION_MAX_AGE_SECONDS,
	});
}

export function clearCheckoutSelection(cookies: CookieDeleter): void {
	cookies.delete(CHECKOUT_SELECTION_COOKIE_NAME, { path: CHECKOUT_SELECTION_COOKIE_PATH });
}

/** The summary route's selection inputs — only what is present. */
export function summaryInputFor(selection: CheckoutSelection): Record<string, unknown> {
	return {
		...(selection.country !== undefined
			? {
					shippingAddress: {
						country: selection.country,
						...(selection.region !== undefined ? { region: selection.region } : {}),
					},
				}
			: {}),
		...(selection.shippingMethodId !== undefined
			? { shippingMethodId: selection.shippingMethodId }
			: {}),
		...(selection.couponCode !== undefined ? { couponCode: selection.couponCode } : {}),
	};
}
