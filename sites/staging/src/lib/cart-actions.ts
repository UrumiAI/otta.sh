/**
 * Shared plumbing for the /cart/* POST endpoints — the "theme shim" side
 * of the plugin's cart routes (ADR-0003): the site endpoint owns the
 * cookie (read + Set-Cookie via the descriptor shim) and the redirect;
 * the plugin routes own the cart logic as straight service proxies.
 *
 * CSRF: every /cart/* endpoint calls `rejectCrossOrigin` (origin-guard.ts)
 * FIRST — Astro's `security.checkOrigin` is force-disabled by the emdash
 * integration and its replacement layer covers only /_emdash/api/* routes
 * (ADR-0006) — plus the cart cookie's SameSite=Lax.
 */
import {
	CART_COOKIE_NAME,
	CART_COOKIE_PATH,
	STOREFRONT_CART_CREATE_ROUTE,
	type CartCreateRouteResult,
} from "@otta-sh/plugin";
import type { APIContext } from "astro";
import type { PublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { getPublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { applyCartCookie } from "./cart-cookie.js";
import { dispatchOttaRoute, isBusyResult, sameSitePath } from "./otta-api.js";

/** Semantic error tokens this shim adds on top of the plugin's own
 *  (`RENDER_FAILED`, `OUT_OF_STOCK`, ...). */
export const SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE";

/** `/cart/add`'s pre-check tokens (item 3 — bogus SKU/productId rejection):
 *  a submitted `productId` that doesn't resolve to a live CMS entry, or one
 *  whose live product disagrees with the submitted `sku` / isn't
 *  purchasable. Rejected BEFORE the plugin's add-line route is ever called. */
export const PRODUCT_NOT_FOUND = "PRODUCT_NOT_FOUND";
export const PRODUCT_UNAVAILABLE = "PRODUCT_UNAVAILABLE";

/** 303 See Other — the POST-redirect-GET turn. The target is normalized to a
 *  same-site path first ({@link sameSitePath}; `/` if it is not one), so a
 *  dot-segment path that resolves to `//host` can never become the Location. */
export function seeOther(context: APIContext, path: string, error?: string): Response {
	const url = new URL(sameSitePath(path), context.url);
	if (error !== undefined) url.searchParams.set("error", error);
	return context.redirect(url.pathname + url.search, 303);
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
 * `cart/create` carries no key, so a BUSY here is never auto-retried.
 */
export async function ensureCartId(
	context: APIContext,
	handler: PublicPluginApiRouteHandler | undefined,
): Promise<EnsureCartResult> {
	const existing = currentCartId(context);
	if (existing !== undefined) return { ok: true, cartId: existing };

	const created = await dispatchOttaRoute<CartCreateRouteResult>(
		handler,
		STOREFRONT_CART_CREATE_ROUTE,
		{},
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
