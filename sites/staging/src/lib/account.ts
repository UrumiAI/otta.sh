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
	LOGIN_LINK_MAX_ACTIVE,
	LOGIN_LINK_TTL_MS,
	SESSION_COOKIE_NAME,
	type AccountMeResult,
	type AccountOrderResult,
	type SessionCookieDescriptor,
} from "@otta-sh/plugin";
import type { PublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { dispatchOttaRoute } from "./otta-api.js";
import { SITE_LOCALE } from "./site-locale.js";
import { isOrderPayable } from "./pay-guard.js";

/** The one notice a link request ends on, whatever the plugin knows about the
 *  address — the page must not become an account oracle (ADR-0004). It must
 *  also be TRUE for every address: a link goes to a new address too (redeeming
 *  it creates the account), so an "if an account exists" hedge would tell a
 *  first-time shopper they get nothing, while the sign-in page tells them the
 *  same link signs them up. The view leads it with "Check your inbox.", so it
 *  must not open with those words again. It states the per-address cap, which is
 *  true of every address and the one honest explanation for a link that never
 *  comes (QA U-12). */
export const LOGIN_LINK_SENT_COPY =
	"A sign-in link is on its way. It works once and expires in 15 minutes. If it doesn't arrive, check the address — we send at most 3 links to an address every 15 minutes.";

/**
 * The plugin's per-address cap (ADR-0004: at most 3 unconsumed links per address,
 * each live for 15 minutes; past it a request sends nothing and answers exactly as
 * a sent one does) — the verifier's own constants, re-exported by the plugin, so
 * the notices cannot drift from them (account.test.ts pins the copy to them).
 * Used here only to bound this browser's own count; the plugin enforces the cap.
 */
export const LOGIN_LINK_CAP = LOGIN_LINK_MAX_ACTIVE;
export const LOGIN_LINK_WINDOW_MS = LOGIN_LINK_TTL_MS;

/**
 * The notice for a browser that has itself asked for more than
 * {@link LOGIN_LINK_CAP} links inside the window (QA U-12: the fourth request was
 * silently dropped while the page said the link was on its way).
 *
 * NOT AN ORACLE. It is decided by THIS BROWSER's own request count (a cookie
 * holding nothing but timestamps), never by the plugin's answer, which stays
 * identical for every address (ADR-0004). So it reads the same whatever address
 * was typed — a new one, a known one, four different ones — and says only what is
 * true of any of them: past the cap, a request may not send.
 */
export const LOGIN_LINK_MANY_COPY =
	"You've asked for several links in the last 15 minutes. We send at most 3 links to an address in that time, so this request may not have sent a new one. Use the newest link you received, or try again in 15 minutes.";

/** This browser's recent link requests: timestamps only, never an address. */
export const LOGIN_REQUESTS_COOKIE_NAME = "otta_login_requests";

/** The requests a cookie value records inside the window, oldest first. Anything
 *  unreadable is dropped — the count can only err towards the ordinary notice. */
export function recentLoginRequests(raw: string | undefined, now: number): number[] {
	if (raw === undefined || raw.length === 0) return [];
	return raw
		.split(".")
		.filter((part) => /^\d{1,15}$/.test(part))
		.map(Number)
		.filter((at) => at <= now && now - at < LOGIN_LINK_WINDOW_MS)
		.toSorted((a, b) => a - b);
}

/**
 * Record one more request from this browser and say which notice it gets:
 * `"many"` once this browser has asked more than {@link LOGIN_LINK_CAP} times in
 * the window, else `"1"` (the ordinary notice). Keeps at most CAP + 1 entries, so
 * the cookie stays a few dozen bytes however often the button is pressed.
 */
export function recordLoginRequest(
	cookies: Pick<SessionCookieJar, "get"> & {
		set(
			name: string,
			value: string,
			options: {
				httpOnly: boolean;
				secure: boolean;
				sameSite: "lax";
				path: string;
				maxAge: number;
			},
		): void;
	},
	now: number,
): "1" | "many" {
	const recent = [
		...recentLoginRequests(cookies.get(LOGIN_REQUESTS_COOKIE_NAME)?.value, now),
		now,
	].slice(-(LOGIN_LINK_CAP + 1));
	cookies.set(LOGIN_REQUESTS_COOKIE_NAME, recent.map(String).join("."), {
		httpOnly: true,
		secure: true,
		sameSite: "lax",
		path: ACCOUNT_LOGIN_PATH,
		maxAge: LOGIN_LINK_WINDOW_MS / 1000,
	});
	return recent.length > LOGIN_LINK_CAP ? "many" : "1";
}

/** `Cache-Control` for every page that renders a customer's own data: it must
 *  never be stored by a shared cache, nor replayed from the back/forward cache
 *  after logout. The site's ONE such constant, under the name the account pages
 *  already use. */
export { PRIVATE_NO_STORE as ACCOUNT_NO_STORE } from "./no-store.js";

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
		return formatMoney(cents(amountCents), currency(currencyCode), SITE_LOCALE);
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
	expired: "Payment not completed — expired",
	failed: "Payment didn't go through",
};

/**
 * The order's status in the account's words — the same facts the public order
 * page states (`lib/order-stamp.ts`), in a phrase short enough for a list row
 * (QA U-5: an unpaid, a declined and an expired order all read "Awaiting
 * payment").
 *
 * A `pending` order is awaiting payment only while it can still BE paid
 * (`isOrderPayable`, the pay page's own rule): a declined card leaves an order
 * pending and payable (ADR-0022), so that is honestly still "Awaiting payment";
 * past its hold the pay page refuses it, and the sweep is about to expire it, so
 * it says the time ran out — as the order page does. An unknown state still
 * reads, rather than leaking a snake_case token.
 */
export function accountOrderStatus(
	order: { state: string; holdExpiresAt: string },
	now: Date,
): string {
	if (order.state === "pending" && !isOrderPayable(order, now)) {
		return "Payment not completed — time ran out";
	}
	return STATE_LABELS[order.state] ?? order.state.replaceAll("_", " ");
}

/**
 * The refunded figure on the account's order page, as its own line beside the
 * paid total — only where the order's ledger shows recorded refunds
 * (`AccountOrderWire.refundedCents`). `null` for none, which includes a refund
 * made outside Otta ("Mark refunded", ADR-0026): the order's status then says
 * "Refunded", and the page invents no amount for it.
 */
export function orderRefundedNote(refundedCents: number, currencyCode: string): string | null {
	return refundedCents > 0 ? `Refunded ${orderMoney(refundedCents, currencyCode)}` : null;
}

const PLACED_ON = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

/**
 * When an order was placed, as a calendar date ("Oct 2, 2026") plus the instant
 * for a `<time datetime>`. In UTC, like every other time this server renders
 * (`lib/hold.ts`): it cannot know the shopper's zone. `null` for an unreadable
 * date — no date beats a wrong one.
 */
export function orderPlacedOn(iso: string): { text: string; iso: string } | null {
	const instant = Date.parse(iso);
	if (!Number.isFinite(instant)) return null;
	return { text: PLACED_ON.format(instant), iso };
}
