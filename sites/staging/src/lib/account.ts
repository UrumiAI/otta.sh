/**
 * The customer account's site half (issue #306, ADR-0004).
 *
 * The plugin owns identity and cannot set a cookie (ADR-0003), so — exactly like
 * the cart — its verify route hands back a session-cookie DESCRIPTOR and THIS
 * site owns the `Set-Cookie`. Every attribute is applied verbatim; the only
 * translation is the absolute `expiresAt` → Astro's `expires` Date. A dropped
 * attribute here is a hijackable session, and the endpoint suite asserts the
 * exact call.
 */
import {
	ACCOUNT_ME_ROUTE,
	ACCOUNT_ORDER_ROUTE,
	cents,
	currency,
	formatMoney,
	SESSION_COOKIE_NAME,
	type AccountMeResult,
	type AccountOrderResult,
	type SessionCookieDescriptor,
} from "@otta-sh/plugin";
import type { PublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { dispatchOttaRoute } from "./otta-api.js";

/** The one notice a link request ends on, whatever the plugin knows about the
 *  address — the page must not become an account oracle (ADR-0004). It must
 *  also be TRUE for every address: a link goes to a new address too (redeeming
 *  it creates the account), so an "if an account exists" hedge would tell a
 *  first-time shopper they get nothing, while the sign-in page tells them the
 *  same link signs them up. The view leads it with "Check your inbox.", so it
 *  must not open with those words again. */
export const LOGIN_LINK_SENT_COPY =
	"A sign-in link is on its way. It works once and expires in 15 minutes. If it doesn't arrive, check the address and request another.";

/** `Cache-Control` for every page that renders a customer's own data: it must
 *  never be stored by a shared cache, nor replayed from the back/forward cache
 *  after logout. */
// TODO(after fix/new-cart-after-order and feat/account-signed-in-ux merge):
// consolidate the four "private, no-store" constants — this one,
// PER_SHOPPER_NO_STORE (middleware.ts), THEME_PREVIEW_NO_STORE (theme-preview.ts)
// and PRIVATE_NO_STORE — into lib/no-store.ts, which both branches add verbatim
// and so must not diverge before then.
export const ACCOUNT_NO_STORE = "private, no-store";

/** Where a signed-in customer lands, and where the header's "Account" points. */
export const ACCOUNT_HOME_PATH = "/account/orders";

/** The sign-in page. It renders with a session open too, and its link's verify
 *  step is what joins a guest order to the account (verifyLogin's
 *  linkGuestOrders) — so it is where "sign in to see this order" must point. */
export const ACCOUNT_LOGIN_PATH = "/account/login";

export interface SessionCookieOptions {
	httpOnly: boolean;
	secure: boolean;
	sameSite: "lax" | "strict" | "none";
	path: string;
	expires: Date;
}

/** The slice of Astro's `AstroCookies` this module touches — injectable, so the
 *  suite can observe the exact calls. */
export interface SessionCookieJar {
	get(name: string): { value: string } | undefined;
	set(name: string, value: string, options: SessionCookieOptions): void;
	delete(name: string, options: { path: string }): void;
}

export function applySessionCookie(
	cookies: Pick<SessionCookieJar, "set">,
	descriptor: SessionCookieDescriptor,
): void {
	cookies.set(descriptor.name, descriptor.value, {
		httpOnly: descriptor.httpOnly,
		secure: descriptor.secure,
		sameSite: descriptor.sameSite,
		path: descriptor.path,
		expires: new Date(descriptor.expiresAt),
	});
}

/** Same name, same path as the setter — a mismatched path deletes nothing. */
export function clearSessionCookie(cookies: Pick<SessionCookieJar, "delete">): void {
	cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
}

export function currentSessionToken(cookies: Pick<SessionCookieJar, "get">): string | undefined {
	const value = cookies.get(SESSION_COOKIE_NAME)?.value;
	return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * The signed-in shopper's email, or `null` when signed out — asked of the plugin
 * with the cookie's bearer (`storefront/account/me`), never read off the cookie,
 * which is only a token. No cookie ⇒ no dispatch. Anything but a clean answer
 * (a stale session, BUSY, an unreachable plugin) reads as signed out: every caller
 * renders a page that works for a guest, so failing that way costs a greeting,
 * never the page.
 */
export async function signedInEmail(
	handler: PublicPluginApiRouteHandler | undefined,
	cookies: Pick<SessionCookieJar, "get">,
	url: URL,
): Promise<string | null> {
	const sessionToken = currentSessionToken(cookies);
	if (sessionToken === undefined) return null;
	const result = await dispatchOttaRoute<AccountMeResult>(
		handler,
		ACCOUNT_ME_ROUTE,
		{ sessionToken },
		url,
	);
	return result !== null && result.ok ? result.email : null;
}

/**
 * Is `orderId` the signed-in shopper's own order? Asked through the session's own
 * order read (`storefront/account/order`), so ownership is the plugin's answer —
 * the public order deliberately carries no email to compare. No session ⇒ `false`
 * without a dispatch; anything but a clean yes is `false`, which only means the
 * page shows the sign-in wording instead of the direct link.
 */
export async function sessionOwnsOrder(
	handler: PublicPluginApiRouteHandler | undefined,
	cookies: Pick<SessionCookieJar, "get">,
	orderId: string,
	url: URL,
): Promise<boolean> {
	const sessionToken = currentSessionToken(cookies);
	if (sessionToken === undefined) return false;
	const result = await dispatchOttaRoute<AccountOrderResult>(
		handler,
		ACCOUNT_ORDER_ROUTE,
		{ sessionToken, orderId },
		url,
	);
	return result !== null && result.ok;
}

/**
 * The note under checkout's email field. Signed in, the field is prefilled with
 * the account's address, and the note says what changing it means: the order is
 * filed under the account only when it is placed with the account's own email
 * (the plugin's rule), so a different one — a gift, a work address — stays out of
 * it. Checkout carries no client JS, so this cannot react to typing; it is said up
 * front instead.
 */
export function checkoutEmailNote(accountEmail: string | null): string {
	return accountEmail === null
		? "We use this to send your order confirmation and to link the order to your account if you sign in later."
		: `Signed in as ${accountEmail}. An order placed with a different email won't appear in your account.`;
}

/** The plugin's failed-verify reasons → the site's own `?error=` tokens, so the
 *  copy (`error-messages.ts`) says "sign-in link" rather than a bare "expired". */
export function verifyFailureToken(reason: "EXPIRED" | "INVALID" | "CONSUMED"): string {
	switch (reason) {
		case "CONSUMED":
			return "LOGIN_LINK_USED";
		case "EXPIRED":
			return "LOGIN_LINK_EXPIRED";
		default:
			return "LOGIN_LINK_INVALID";
	}
}

/**
 * Integer minor units → display money. The account wire carries bare cents
 * (`OrderSummaryWire.totals.*Cents`), so this is the one place the site formats
 * money itself, and it does so through the plugin's own `formatMoney` (ICU
 * minor-unit digits, never float arithmetic). Anything that is not a safe
 * integer in a real currency renders a dash rather than a plausible wrong
 * amount.
 */
export function orderMoney(amountCents: number, currencyCode: string): string {
	try {
		return formatMoney(cents(amountCents), currency(currencyCode), "en-US");
	} catch {
		return "—";
	}
}

const STATE_LABELS: Record<string, string> = {
	pending: "Awaiting payment",
	paid: "Paid",
	processing: "Processing",
	shipped: "Shipped",
	delivered: "Delivered",
	completed: "Completed",
	cancelled: "Cancelled",
	refunded: "Refunded",
	expired: "Expired",
	failed: "Payment failed",
};

/** The order's state in words. An unknown state still reads, rather than
 *  leaking a snake_case token. */
export function orderStateLabel(state: string): string {
	return STATE_LABELS[state] ?? state.replaceAll("_", " ");
}
