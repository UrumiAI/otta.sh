/**
 * The `otta_checkout` stash — the site→`/checkout/pay` handoff.
 *
 * `POST /checkout/place` receives the order id, the Stripe client secret and
 * the order's total; `/checkout/pay` needs the first two to mount the Payment
 * Element and the third to say what it is charging. They travel in a
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

export const CHECKOUT_COOKIE_NAME = "otta_checkout";

/** 15 minutes — the domain's `DEFAULT_CHECKOUT_TTL_MS`. The stash is useless
 *  the moment the hold it points at expires, so it dies with it. */
export const CHECKOUT_COOKIE_MAX_AGE_SECONDS = 900;

/**
 * The order total, captured at PLACE-TIME — the figure the PaymentIntent was
 * minted for, so the pay step can say what it is charging (§7: "Pay $40.00",
 * not "Pay now").
 *
 * Two decisions worth stating, because this is the payment path:
 *
 *  - It is a SNAPSHOT, not a pointer. /checkout/pay makes no commerce call, and
 *    the cart the order came from is still live — a total re-derived there could
 *    disagree with the amount Stripe will actually take. This travels with the
 *    client secret because it was true at the same instant.
 *  - It carries a PRE-FORMATTED string and no minor-unit number. `formatMoney`
 *    is the plugin's one sanctioned money→display boundary and takes branded
 *    `Cents`/`Currency`; the site owns no formatter and no locale, and §7's rule
 *    is that this theme never assembles a money string. Storing the amount would
 *    mean re-branding a JSON-parsed `number` on the pay page — a float or a NaN
 *    away from a wrong figure on a payment button — to re-derive a string the
 *    plugin already produced. So the site holds no money NUMBER at all, which is
 *    a stronger property than "no floats". `currency` rides along because it is
 *    a plain code the layout prints (§7's footer chip), not money.
 */
export interface CheckoutStashTotal {
	/** ISO-4217 code, as the order's own totals block reported it. */
	currency: string;
	/** Display money, formatted by the plugin at place-time. */
	formatted: string;
}

export interface CheckoutStash {
	orderId: string;
	clientSecret: string;
	/**
	 * ABSENT on a stash minted before the total shipped — a live one can be up
	 * to `CHECKOUT_COOKIE_MAX_AGE_SECONDS` old across a deploy — and absent
	 * again if it ever arrives malformed. The pay page falls back to "Pay now";
	 * it never blocks the payment on a missing label.
	 */
	total?: CheckoutStashTotal;
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

const STASH_CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * The total, or undefined — and the asymmetry with the two fields above is the
 * whole point. `orderId` and `clientSecret` are load-bearing: without them there
 * is nothing to pay and the read fails. The total is a LABEL. A stash written
 * before this field existed, or one whose total arrives half-shaped, must still
 * pay the order; it simply loses the amount off the button.
 *
 * Exported because BOTH ends use it: `place.ts` runs the plugin route's reply
 * through it before writing (the dispatcher hands back parsed JSON that its
 * result type only ASSERTS the shape of), and the read below runs the cookie
 * through it. It is ONE function so the two ends apply the same rule — a shape
 * the writer would reject can never be a shape the reader accepts — and so that
 * neither end can turn a missing label into a failed payment. It is not a claim
 * that both ends see the same INPUT: the writer reads a fresh route reply, the
 * reader reads a cookie that may be a deploy old.
 *
 * `currency` is checked against ISO-4217's alpha shape rather than merely being
 * non-empty, because the layout prints it as a currency chip. This cannot reject
 * anything the plugin emits — `currency()` enforces exactly this pattern before
 * `formatMoney` ever runs — so it only ever fires on a cookie that was not
 * written by the current writer. And it DROPS, like every other malformed shape
 * here; it does not throw.
 */
export function checkoutStashTotal(value: unknown): CheckoutStashTotal | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { currency, formatted } = value as Record<string, unknown>;
	if (typeof currency !== "string" || !STASH_CURRENCY_PATTERN.test(currency)) return undefined;
	if (typeof formatted !== "string" || formatted.length === 0) return undefined;
	return { currency, formatted };
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
	const { orderId, clientSecret, total } = parsed as Record<string, unknown>;
	if (typeof orderId !== "string" || orderId.length === 0) return null;
	if (typeof clientSecret !== "string" || clientSecret.length === 0) return null;
	const stash: CheckoutStash = { orderId, clientSecret };
	const parsedTotal = checkoutStashTotal(total);
	if (parsedTotal !== undefined) stash.total = parsedTotal;
	return stash;
}

/** Same name, same path as the setter — a mismatched path silently deletes
 *  nothing. */
export function clearCheckoutCookie(cookies: CookieDeleter): void {
	cookies.delete(CHECKOUT_COOKIE_NAME, { path: "/" });
}
