/**
 * The buyer's coupon on its way through the review page (#305 part 1).
 *
 * It rides the URL as `GET /checkout?coupon=CODE` (decision D2) rather than a
 * cookie or a POST: the summary it drives is READ-ONLY (a quote redeems
 * nothing), so the GET is safe, a reload re-applies it, and there is nothing to
 * clear. The place form then echoes the code the review priced as a hidden
 * `couponCode`, and the plugin re-checks it.
 *
 * Two costs, stated plainly:
 *  - the code sits in history and access logs. It is not personal data, but a
 *    single-use private code is exposed; the page sends `same-origin` so it at
 *    least never leaves for another host in a Referer (not `no-referrer`, under
 *    which browsers send `Origin: null` on the page's own POSTs — Fetch's
 *    "append a request `Origin` header" — and the origin guard 403s them). Its
 *    own POSTs DO carry the full URL as Referer, so their responses send
 *    `no-referrer` (`withoutReferrer`, cart-actions.ts) and the page they
 *    redirect to never sees the code in `document.referrer`;
 *  - applying a coupon is a navigation, so fields typed into the place form are
 *    lost — the same no-personal-data-in-URLs trade-off `place.ts` documents.
 *    The coupon field sits FIRST on the page for that reason.
 *
 * Codes are trimmed and never case-folded here: the plugin's coupon lookup
 * ignores case (ADR-0025), and the code is echoed as the buyer typed it.
 *
 * #305 part 2 (ADR-0021) adds the DESTINATION and the shipping METHOD, by the
 * same GET: the delivery form submits `?country=US&region=CA&method=<id>`. Only
 * that — the coarse country, a region CODE, the opaque method id, the coupon and
 * an error token — ever goes in a URL (Decision 9): never a name, street, city,
 * postcode, phone or email. `checkoutPath` is the one builder and knows no
 * other key. Like the coupon, resubmitting the delivery form loses the address
 * fields typed below it.
 */
import { isCodeShapedRegion } from "@otta-sh/plugin";

/** The query parameter the coupon form submits. */
export const COUPON_PARAM = "coupon";

/** The delivery form's parameters (ADR-0021). `fromCountry`/`fromRegion` are
 *  hidden echoes of the destination the page was rendered for, so a changed
 *  destination can drop a method chosen for the old one. */
export const COUNTRY_PARAM = "country";
export const REGION_PARAM = "region";
export const METHOD_PARAM = "method";
export const FROM_COUNTRY_PARAM = "fromCountry";
export const FROM_REGION_PARAM = "fromRegion";

/** The plugin's own cap (`COUPON_CODE_MAX`). Over it, the plugin would answer
 *  INVALID_INPUT; the site says what is true instead — no such coupon. */
export const COUPON_CODE_MAX = 200;

const NOT_FOUND = "COUPON_NOT_FOUND" as const;

export type CouponRead =
	| { couponCode?: undefined; rejected?: undefined }
	| { couponCode: string; rejected?: undefined }
	| { couponCode?: undefined; rejected: { code: string; reason: typeof NOT_FOUND } };

/** A raw coupon value → a code, nothing, or a refusal made here. */
export function readCouponCode(raw: string | null | undefined): CouponRead {
	const code = (raw ?? "").trim();
	if (code.length === 0) return {};
	if (code.length > COUPON_CODE_MAX) return { rejected: { code, reason: NOT_FOUND } };
	return { couponCode: code };
}

export function readCouponParam(url: URL): CouponRead {
	return readCouponCode(url.searchParams.get(COUPON_PARAM));
}

/** The selection a `/checkout` URL may carry — and nothing else. */
export interface CheckoutUrlSelection {
	couponCode?: string | undefined;
	country?: string | undefined;
	region?: string | undefined;
	shippingMethodId?: string | undefined;
}

/**
 * `/checkout`, carrying the selection and/or an `?error=` token. Blank values
 * are omitted. It reads ONLY the named keys, so a caller that spreads a whole
 * form in still cannot put an address or an email in the URL.
 */
export function checkoutPath(
	options: CheckoutUrlSelection & { error?: string | undefined },
): string {
	const params = new URLSearchParams();
	const put = (key: string, value: string | undefined): void => {
		if (value !== undefined && value.length > 0) params.set(key, value);
	};
	put(COUPON_PARAM, options.couponCode);
	put(COUNTRY_PARAM, options.country);
	put(REGION_PARAM, options.region);
	put(METHOD_PARAM, options.shippingMethodId);
	put("error", options.error);
	const query = params.toString();
	return query.length > 0 ? `/checkout?${query}` : "/checkout";
}

/** Two letters — the SHAPE of an ISO 3166-1 alpha-2 code. */
const COUNTRY_SHAPE = /^[A-Za-z]{2}$/;

/** The site's own token for a typed region that is not a code: never
 *  dispatched, explained with the plugin's own copy. */
const REGION_CODE_REQUIRED = "SHIPPING_REGION_CODE_REQUIRED" as const;

export interface DestinationRead {
	destination?: { country: string; region?: string };
	/** A region that is not even code-shaped — refused here; the typing is
	 *  kept so the field can be put back for correcting. */
	rejected?: { reason: typeof REGION_CODE_REQUIRED; country: string; region: string };
	/** The destination changed from the one the page was rendered for, so a
	 *  method chosen for the old one must not ride along. */
	methodDropped: boolean;
}

/**
 * A destination from a FORM (the place form's hidden echo) → only what passes
 * the same SHAPE checks as the delivery form's GET: a two-letter country and a
 * code-shaped region, both uppercased. A crafted POST can put anything in a
 * hidden field, and these values go back into a redirect URL — so anything
 * else is dropped, and a region without a valid country goes with it.
 */
export function shapedDestination(
	country: string | undefined,
	region: string | undefined,
): { country?: string; region?: string } {
	const code = (country ?? "").trim().toUpperCase();
	if (!COUNTRY_SHAPE.test(code)) return {};
	const sub = (region ?? "").trim();
	return sub.length > 0 && isCodeShapedRegion(sub)
		? { country: code, region: sub.toUpperCase() }
		: { country: code };
}

/** A region, NORMALISED for comparison: trimmed, uppercased, and its own
 *  country's `CC-` prefix stripped — so `ca`, `CA` and `US-CA` are equal. */
function comparableRegion(country: string, region: string | null): string {
	const upper = (region ?? "").trim().toUpperCase();
	const prefix = `${country.trim().toUpperCase()}-`;
	return upper.startsWith(prefix) ? upper.slice(prefix.length) : upper;
}

/**
 * The delivery form's GET → the destination to price for. The country comes
 * from a `<select>`; anything that is not two letters (a hand-typed URL) is
 * simply no destination. The region is typed: blank ⇒ none, a code shape ⇒
 * uppercased, anything else ⇒ refused HERE (never dispatched). Whether a
 * code-shaped value is a REAL subdivision is the plugin's call.
 */
export function readDestinationParams(url: URL): DestinationRead {
	const country = (url.searchParams.get(COUNTRY_PARAM) ?? "").trim().toUpperCase();
	const region = (url.searchParams.get(REGION_PARAM) ?? "").trim();
	const fromCountry = url.searchParams.get(FROM_COUNTRY_PARAM);
	const fromRegion = url.searchParams.get(FROM_REGION_PARAM);
	if (!COUNTRY_SHAPE.test(country)) return { methodDropped: false };
	const methodDropped =
		fromCountry !== null &&
		(fromCountry.trim().toUpperCase() !== country ||
			comparableRegion(country, fromRegion) !== comparableRegion(country, region));
	if (region.length === 0) return { destination: { country }, methodDropped };
	if (!isCodeShapedRegion(region)) {
		return { rejected: { reason: REGION_CODE_REQUIRED, country, region }, methodDropped };
	}
	return { destination: { country, region: region.toUpperCase() }, methodDropped };
}

/**
 * What the delivery block's country and region fields show: the destination the
 * totals were priced for; else the one the site refused by shape (so a typo can
 * be fixed); else the one the buyer ASKED for and the PLUGIN refused — a US
 * store with a state-level zone refuses plain `US` (SHIPPING_REGION_CODE_REQUIRED)
 * — so the country stays chosen and its state/province list is shown. Without
 * that last step the page asked for a state from a list it did not print.
 */
export function deliveryFieldValues(
	priced: { country: string; region: string | null } | null,
	read: DestinationRead,
): { country: string; region: string } {
	if (priced !== null) return { country: priced.country, region: priced.region ?? "" };
	if (read.rejected !== undefined) {
		return { country: read.rejected.country, region: read.rejected.region };
	}
	if (read.destination !== undefined) {
		return { country: read.destination.country, region: read.destination.region ?? "" };
	}
	return { country: "", region: "" };
}

/** The plugin's own id bound: printable ASCII, no whitespace, 1–200. */
const METHOD_ID = /^[\x21-\x7e]{1,200}$/;

/** The chosen delivery method, when it is id-shaped. */
export function readMethodParam(url: URL): string | undefined {
	const method = (url.searchParams.get(METHOD_PARAM) ?? "").trim();
	return METHOD_ID.test(method) ? method : undefined;
}

/** True for a token that refuses the COUPON (the plugin's `COUPON_*` reasons). */
export function isCouponFailure(token: string): boolean {
	return token.startsWith("COUPON_");
}

/** Tokens that refuse the DESTINATION (ADR-0021): it — and the method, which
 *  only means something inside the zone it came from — are dropped. */
const DESTINATION_FAILURES: ReadonlySet<string> = new Set([
	"INVALID_SHIPPING_ADDRESS",
	"SHIPPING_ZONE_NOT_MATCHED",
	"SHIPPING_REGION_CODE_REQUIRED",
]);

export function isDestinationFailure(token: string): boolean {
	return DESTINATION_FAILURES.has(token);
}

/** Tokens that refuse only the METHOD: the destination stays. */
export function isMethodFailure(token: string): boolean {
	return (
		token === "MISSING_SHIPPING_ADDRESS" ||
		(token.startsWith("SHIPPING_") && !DESTINATION_FAILURES.has(token))
	);
}

/**
 * Where a failed place sends the buyer. The part of the selection the failure
 * blames is DROPPED, so the review re-renders without it and with ONE notice
 * (the error's) — keeping it would re-quote the same refusal and show it twice:
 * a coupon failure drops the coupon; a destination failure the destination and
 * the method; a method failure the method. Anything else keeps the whole
 * selection: none of it is personal data, and the buyer did not ask to lose
 * their discount or their delivery choice because an email was mistyped.
 */
export function placeFailurePath(token: string, selection: CheckoutUrlSelection): string {
	const dropDestination = isDestinationFailure(token);
	const dropMethod = dropDestination || isMethodFailure(token);
	// A refusal for the REGION blames only the region: the country stays, so the
	// review comes back with that country's state list (refused again, marked).
	const keepCountry = token === "SHIPPING_REGION_CODE_REQUIRED";
	return checkoutPath({
		couponCode: isCouponFailure(token) ? undefined : selection.couponCode,
		country: dropDestination && !keepCountry ? undefined : selection.country,
		region: dropDestination ? undefined : selection.region,
		shippingMethodId: dropMethod ? undefined : selection.shippingMethodId,
		error: token,
	});
}

/**
 * The delivery fields the details form posts (QA U-1). They belong to the place
 * form (`form="checkout-place"`) under names of their own — `deliveryCountry`,
 * `deliveryRegion`, `deliveryMethod` — beside the priced echo (`country`,
 * `region`, `shippingMethodId`) and the destination the options were priced for
 * (`fromCountry`, `fromRegion`).
 */
export interface DeliveryFields {
	country?: string | undefined;
	region?: string | undefined;
	method?: string | undefined;
	fromCountry?: string | undefined;
	fromRegion?: string | undefined;
}

/** Bounded like the inputs that produce them; anything longer was not typed there. */
const DELIVERY_FIELD_MAX = 32;

function bounded(value: string | undefined): string | undefined {
	const trimmed = (value ?? "").trim();
	return trimmed.length > 0 && trimmed.length <= DELIVERY_FIELD_MAX ? trimmed : undefined;
}

/**
 * Where "Update delivery" goes: exactly the `/checkout?…` the old GET form
 * produced (coupon, country, region, method, fromCountry, fromRegion), so the
 * review's own readers — the shape checks, the refused-region notice, the method
 * dropped on a changed destination — apply unchanged. Only coarse codes and an
 * opaque method id: no personal data reaches the URL.
 */
export function deliveryUpdatePath(
	fields: DeliveryFields,
	couponCode: string | undefined,
	error?: string,
): string {
	const params = new URLSearchParams();
	const put = (key: string, value: string | undefined): void => {
		if (value !== undefined) params.set(key, value);
	};
	const country = bounded(fields.country)?.toUpperCase();
	put(COUPON_PARAM, couponCode);
	put(COUNTRY_PARAM, country !== undefined && COUNTRY_SHAPE.test(country) ? country : undefined);
	put(REGION_PARAM, bounded(fields.region));
	const method = bounded(fields.method);
	put(METHOD_PARAM, method !== undefined && METHOD_ID.test(method) ? method : undefined);
	put(FROM_COUNTRY_PARAM, bounded(fields.fromCountry)?.toUpperCase());
	put(FROM_REGION_PARAM, bounded(fields.fromRegion));
	put("error", error);
	const query = params.toString();
	return query.length > 0 ? `/checkout?${query}` : "/checkout";
}

/**
 * Do the posted delivery fields differ from what the totals were priced with?
 * A different country, region (compared as codes: `ca`, `CA`, `US-CA` are one)
 * or a different method radio. Absent delivery fields (no delivery block on the
 * page) never differ.
 */
export function deliveryDiffers(
	fields: DeliveryFields,
	priced: {
		country?: string | undefined;
		region?: string | undefined;
		method?: string | undefined;
	},
): boolean {
	const country = bounded(fields.country)?.toUpperCase();
	if (country === undefined) return false;
	const pricedCountry = (priced.country ?? "").trim().toUpperCase();
	if (country !== pricedCountry) return true;
	if (
		comparableRegion(country, fields.region ?? null) !==
		comparableRegion(country, priced.region ?? null)
	) {
		return true;
	}
	const method = bounded(fields.method);
	return method !== undefined && method !== priced.method;
}
