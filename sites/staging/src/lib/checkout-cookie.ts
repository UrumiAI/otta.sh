/**
 * The `urumi_checkout` stash — the site→`/checkout/pay` handoff.
 *
 * `POST /checkout/place` receives the order id and the Stripe client secret;
 * `/checkout/pay` needs both to mount the Payment Element. They travel in a
 * short-lived first-party cookie rather than a query string or a re-POST:
 *
 *  - a URL parameter would put the client secret in browser history, in
 *    bookmarks and in every support ticket a buyer pastes a URL into;
 *  - rendering the pay step from the POST response breaks POST-redirect-GET
 *    (reload becomes a re-POST);
 *  - re-deriving the secret on a GET would mean a GET that can create an order.
 *
 * ── What this cookie does NOT achieve (ADR-0012 decision 6) ───────────────
 * It keeps the secret out of OUR urls on the leg we control. It does not keep
 * it out of urls generally: Stripe's Payment Element redirect appends
 * `payment_intent_client_secret` to our `return_url`, so one hop later it is in
 * history, in the `Referer` of any subresource on the confirmation page, and in
 * Cloudflare's access logs. That is Stripe's wire format. Our mitigations are
 * the confirmation page's `no-referrer` meta, never echoing the parameters into
 * markup, and this cookie's own deletion on arrival.
 *
 * ── Why `path=/` ─────────────────────────────────────────────────────────
 * So `/orders/[orderId]` can DELETE it. A `path=/checkout` cookie is never sent
 * to the confirmation page and therefore cannot be cleared there, which would
 * leave a spent client secret sitting in the browser for the rest of the hold.
 * The deletion is a hard requirement, not a nicety — without it `path=/` has no
 * justification at all.
 */

export const CHECKOUT_COOKIE_NAME = "urumi_checkout";

/** 15 minutes — the domain's `DEFAULT_CHECKOUT_TTL_MS`. The stash is useless
 *  the moment the hold it points at expires, so it dies with it. */
export const CHECKOUT_COOKIE_MAX_AGE_SECONDS = 900;

export interface CheckoutStash {
	orderId: string;
	clientSecret: string;
}

export interface CookieSetOptions {
	httpOnly: boolean;
	secure: boolean;
	sameSite: "lax" | "strict" | "none";
	path: string;
	maxAge: number;
}

export interface CookieWriter {
	set(name: string, value: string, options: CookieSetOptions): void;
}

export interface CookieReader {
	get(name: string): { value: string } | undefined;
}

export interface CookieDeleter {
	delete(name: string, options: { path: string }): void;
}

/** `SameSite=Lax` is correct and load-bearing: the cookie must ride the
 *  TOP-LEVEL GET navigation Stripe redirects back with. `Strict` would drop it
 *  on exactly that hop. */
export function setCheckoutCookie(cookies: CookieWriter, stash: CheckoutStash): void {
	cookies.set(CHECKOUT_COOKIE_NAME, JSON.stringify(stash), {
		httpOnly: true,
		secure: true,
		sameSite: "lax",
		path: "/",
		maxAge: CHECKOUT_COOKIE_MAX_AGE_SECONDS,
	});
}

/** Null for absent, malformed, or incomplete — a half-read stash must never
 *  reach the Payment Element as `undefined`. */
export function readCheckoutStash(cookies: CookieReader): CheckoutStash | null {
	const raw = cookies.get(CHECKOUT_COOKIE_NAME)?.value;
	if (raw === undefined || raw.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { orderId, clientSecret } = parsed as Record<string, unknown>;
	if (typeof orderId !== "string" || orderId.length === 0) return null;
	if (typeof clientSecret !== "string" || clientSecret.length === 0) return null;
	return { orderId, clientSecret };
}

/** Same name, same path as the setter — a mismatched path silently deletes
 *  nothing. */
export function clearCheckoutCookie(cookies: CookieDeleter): void {
	cookies.delete(CHECKOUT_COOKIE_NAME, { path: "/" });
}
