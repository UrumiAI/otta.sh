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
	cents,
	currency,
	formatMoney,
	SESSION_COOKIE_NAME,
	type SessionCookieDescriptor,
} from "@otta-sh/plugin";

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
