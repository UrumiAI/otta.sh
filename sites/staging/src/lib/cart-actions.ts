/**
 * Shared plumbing for the /cart/* POST endpoints — the "theme shim" side
 * of the plugin's cart routes (ADR-0003): the site endpoint owns the
 * cookie (read + Set-Cookie via the descriptor shim) and the redirect;
 * the plugin routes own the cart logic as straight service proxies.
 *
 * CSRF: the site middleware's origin check (origin-guard.ts) refuses a
 * cross-site POST before any /cart/* endpoint runs — Astro's
 * `security.checkOrigin` is force-disabled by the emdash integration and its
 * replacement layer covers only /_emdash/api/* routes (ADR-0006) — plus the
 * cart cookie's SameSite=Lax.
 */
import {
	CART_COOKIE_NAME,
	CART_COOKIE_PATH,
	STOREFRONT_CART_CREATE_ROUTE,
	type CartCreateRouteResult,
} from "@urumi.ai/otta-plugin";
import type { APIContext } from "astro";
import type { PublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { getPublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { applyCartCookie } from "./cart-cookie.js";
import { dispatchOttaRoute, isBusyResult, sameSitePath } from "./otta-api.js";

/** Semantic error tokens this shim adds on top of the plugin's own
 *  (`RENDER_FAILED`, `OUT_OF_STOCK`, ...). */
export const SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE";

/**
 * Refusals that mean the COOKIE's cart is bad, so the cookie is dropped and the
 * next add mints a fresh cart instead of failing forever:
 * - `CART_NOT_FOUND` — the cookie names a cart that no longer exists;
 * - `INVALID_CART_ID` — the cookie is not a cart-id token. Only the plugin's READ
 *   route returns it; the write routes report a bad cookie as `INVALID_INPUT`. It is
 *   listed so a write that ever starts returning it clears the cookie too;
 * - `INVALID_INPUT` — on the write routes the plugin's input guard also checks the
 *   cart id first, so a tampered cookie lands here. The other fields it guards
 *   (sku, qty, line id, idempotency key) are validated or minted by the site's
 *   own forms, so a legitimate shopper cannot reach it by any other route — as
 *   long as those forms keep matching the guards in the plugin's
 *   `storefront/cart-routes.ts`. Change either side with the other in view.
 *
 * Deliberately NOT here: transient or per-request refusals that leave the cart
 * good (`OUT_OF_STOCK`, `QTY_TOO_LARGE`, `HOLD_EXPIRED`, `LINE_NOT_FOUND`,
 * `LINE_CHECKED_OUT`, `SKU_MISMATCH`, `BUSY`, `RENDER_FAILED`,
 * `SERVICE_UNAVAILABLE`) and `CART_CHECKED_OUT` (a pending order's cart is kept:
 * its payment may still happen, and the cart page offers the way out).
 */
const BAD_CART_COOKIE_TOKENS: ReadonlySet<string> = new Set([
	"CART_NOT_FOUND",
	"INVALID_CART_ID",
	"INVALID_INPUT",
]);

/** `/cart/add`'s pre-check tokens (item 3 — bogus SKU/productId rejection):
 *  a submitted `productId` that doesn't resolve to a live CMS entry, or one
 *  whose live product disagrees with the submitted `sku` / isn't
 *  purchasable. Rejected BEFORE the plugin's add-line route is ever called. */
export const PRODUCT_NOT_FOUND = "PRODUCT_NOT_FOUND";

/** A cart line over the plugin's `CART_LINE_MAX_QTY` — the plugin's own typed
 *  refusal, for a request over the cap and for an add that would merge its line
 *  past it (#608). `/cart/add` and `/cart/update` also give it before dispatch for
 *  an over-cap request (so one never mints a cart). Its copy names the limit. */
export const QTY_TOO_LARGE = "QTY_TOO_LARGE";
export const PRODUCT_UNAVAILABLE = "PRODUCT_UNAVAILABLE";

/** 303 See Other — the POST-redirect-GET turn. The target is normalized to a
 *  same-site path first ({@link sameSitePath}; `/` if it is not one), so a
 *  dot-segment path that resolves to `//host` can never become the Location.
 *
 *  `noticeId` is the id of the element the target page renders `error` in
 *  (`lib/error-notice.ts`, #603): beside an error the Location ends with it as
 *  the fragment, so the page comes back scrolled to the refusal. Any fragment
 *  `path` carried is dropped by the normalization, so there is never two. */
export function seeOther(
	context: APIContext,
	path: string,
	error?: string,
	noticeId?: string,
): Response {
	const url = new URL(sameSitePath(path), context.url);
	if (error !== undefined) url.searchParams.set("error", error);
	const fragment = error !== undefined && noticeId !== undefined ? `#${noticeId}` : "";
	return context.redirect(url.pathname + url.search + fragment, 303);
}

/**
 * Stamp `Referrer-Policy: no-referrer` on a response to one of /checkout's own
 * POSTs (/checkout/place, /checkout/new-cart).
 *
 * The POST carries `/checkout?coupon=…` as its Referer (same-origin allows
 * it), and a 303 keeps the request's referrer — so without this, the page the
 * redirect lands on (/checkout/pay, where js.stripe.com runs) would hold the
 * code in `document.referrer`. A redirect response's `Referrer-Policy` replaces
 * the request's policy for the follow-up GET (Fetch, "HTTP-redirect fetch"), so
 * that GET carries no referrer at all. Applied to EVERY response, not just the
 * 303s to /checkout/pay: one invariant is easier to keep than a list.
 */
export function withoutReferrer(response: Response): Response {
	response.headers.set("Referrer-Policy", "no-referrer");
	return response;
}

export function routeDispatcher(context: APIContext): PublicPluginApiRouteHandler | undefined {
	return getPublicPluginApiRouteHandler(context.locals);
}

export function currentCartId(context: APIContext): string | undefined {
	const value = context.cookies.get(CART_COOKIE_NAME)?.value;
	return value !== undefined && value.length > 0 ? value : undefined;
}

export function clearCartCookie(context: APIContext): void {
	context.cookies.delete(CART_COOKIE_NAME, { path: CART_COOKIE_PATH });
}

/** Drop the cart cookie when `token` says the cart it names is bad (see
 *  {@link BAD_CART_COOKIE_TOKENS}); leave it for any other refusal. */
export function clearCartCookieIfBad(context: APIContext, token: string): void {
	if (BAD_CART_COOKIE_TOKENS.has(token)) clearCartCookie(context);
}

/** {@link ensureCartId}'s answer: a cart id, or WHY there is none — `busy`
 *  (storage contention: the caller answers the busy 503) vs `unavailable`
 *  (anything else: the caller answers SERVICE_UNAVAILABLE). */
export type EnsureCartResult =
	| { ok: true; cartId: string }
	| { ok: false; reason: "busy" | "unavailable" };

/**
 * Ensure a cart exists: reuse the cookie's id, else mint one via the
 * plugin's `storefront/cart/create` and apply its cookie DESCRIPTOR to this
 * response (the plugin cannot set headers — the shim owns Set-Cookie).
 * A KEYED create replays, so its BUSY is retried once (`dispatchOttaRoute`); an
 * unkeyed one never is.
 */
export async function ensureCartId(
	context: APIContext,
	handler: PublicPluginApiRouteHandler | undefined,
	/**
	 * At most one of:
	 *  - `replacesCartId` — when there is no cart, mint the REPLACEMENT for this
	 *    spent cart: the plugin checks it and derives the key, so the same spent cart
	 *    always gets the same new cart (cart-rotation.ts);
	 *  - `idempotencyKey` — mint the cart under this key, so a replay of the same
	 *    request lands in the same cart (#39). It answers that cart to whoever sends
	 *    it: pass only a key this visitor alone holds (see `/cart/add`).
	 */
	opts: { replacesCartId?: string; idempotencyKey?: string } = {},
): Promise<EnsureCartResult> {
	const existing = currentCartId(context);
	if (existing !== undefined) return { ok: true, cartId: existing };

	const created = await dispatchOttaRoute<CartCreateRouteResult>(
		handler,
		STOREFRONT_CART_CREATE_ROUTE,
		opts.replacesCartId !== undefined
			? { replacesCartId: opts.replacesCartId }
			: opts.idempotencyKey !== undefined
				? { idempotencyKey: opts.idempotencyKey }
				: {},
		context.url,
	);
	if (isBusyResult(created)) return { ok: false, reason: "busy" };
	if (created === null || !created.ok) return { ok: false, reason: "unavailable" };
	applyCartCookie(context.cookies, created.cookie);
	return { ok: true, cartId: created.cartId };
}

/** Uniform failure → error token mapping for the line-mutation results. */
export function failureToken(
	result: { ok: false; error: string } | { ok: false; reason: string } | null,
): string {
	if (result === null) return SERVICE_UNAVAILABLE;
	return "reason" in result ? result.reason : result.error;
}
