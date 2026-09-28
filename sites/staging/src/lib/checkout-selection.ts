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
 *    single-use private code is exposed; the page sends `no-referrer` so it at
 *    least never leaves in a Referer;
 *  - applying a coupon is a navigation, so fields typed into the place form are
 *    lost — the same no-personal-data-in-URLs trade-off `place.ts` documents.
 *    The coupon field sits FIRST on the page for that reason.
 *
 * Codes are trimmed and never case-folded: coupon lookup is case-sensitive.
 */

/** The query parameter the coupon form submits. */
export const COUPON_PARAM = "coupon";

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

/** `/checkout`, carrying the coupon and/or an `?error=` token. */
export function checkoutPath(options: { couponCode?: string | undefined; error?: string }): string {
	const params = new URLSearchParams();
	if (options.couponCode !== undefined) params.set(COUPON_PARAM, options.couponCode);
	if (options.error !== undefined) params.set("error", options.error);
	const query = params.toString();
	return query.length > 0 ? `/checkout?${query}` : "/checkout";
}

/** True for a token that refuses the COUPON (the plugin's `COUPON_*` reasons). */
export function isCouponFailure(token: string): boolean {
	return token.startsWith("COUPON_");
}

/**
 * Where a failed place sends the buyer. A coupon failure DROPS the coupon, so
 * the review re-renders without the discount and with ONE notice (the error's)
 * — keeping it would re-quote the same refusal and show it twice. Any other
 * failure keeps it: it is not personal data, and the buyer did not ask to lose
 * their discount because an email was mistyped.
 */
export function placeFailurePath(token: string, couponCode: string | undefined): string {
	return checkoutPath({
		couponCode: isCouponFailure(token) ? undefined : couponCode,
		error: token,
	});
}
