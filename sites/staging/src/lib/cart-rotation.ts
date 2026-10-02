/**
 * Forgetting a SPENT cart — one that has become an order that can no longer be
 * paid — so the shopper's next "Add to cart" starts a new one.
 *
 * A checked-out cart never returns to `active`, so while `otta_cart` names it
 * every add answers CART_CHECKED_OUT. After a PAID order that is the common case,
 * not an edge: the shopper keeps shopping and hits an error, and the only way out
 * was "Start a new cart", whose copy has to warn that it clears any payment still
 * in progress.
 *
 * THE RULE (`isSpentCart`): the cart named THIS order, and the order is no longer
 * `pending`. Only a pending order can still take a payment, and the cart is how
 * that payment is resumed — `/orders/<id>`'s "Complete payment" goes through
 * `/checkout`, which rebuilds its form from this cookie (see `cart/index.astro`'s
 * note on why it deletes nothing). So a pending order's cart is KEPT, and so is
 * any cart this site cannot read or that names no order: not knowing is not proof
 * that nothing is in flight. Those keep the existing way out (the cart page's
 * panel), which the product page's notice now links to.
 *
 * Forgetting is only deleting cookies: the cart itself is untouched (it is the
 * order's record), and the next add mints a fresh cart through `ensureCartId`.
 * The checkout stash goes too — it can only hold a spent client secret here.
 */
import {
	CART_COOKIE_NAME,
	CART_COOKIE_PATH,
	STOREFRONT_CART_READ_ROUTE,
	STOREFRONT_ORDER_ROUTE,
	type CartReadRouteResult,
	type OrderRouteResult,
} from "@otta-sh/plugin";
import type { PublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { clearCheckoutCookie } from "./checkout-cookie.js";
import { dispatchOttaRoute } from "./otta-api.js";

/** The slice of a request this module needs — Astro's `APIContext` and an
 *  `.astro` page's `Astro` global both provide it. */
export interface CartCookieContext {
	cookies: {
		get(name: string): { value: string } | undefined;
		delete(name: string, options: { path: string }): void;
	};
	handler: PublicPluginApiRouteHandler | undefined;
	url: URL;
}

/** The cart became `order`, and `order` can no longer be paid. */
export function isSpentCart(
	cart: { orderId: string | null },
	order: { id: string; state: string },
): boolean {
	return cart.orderId !== null && cart.orderId === order.id && order.state !== "pending";
}

function cookieCartId(ctx: CartCookieContext): string | undefined {
	const value = ctx.cookies.get(CART_COOKIE_NAME)?.value;
	return value !== undefined && value.length > 0 ? value : undefined;
}

function forget(ctx: CartCookieContext): void {
	// Same name and path as the plugin's descriptor: a mismatched path deletes nothing.
	ctx.cookies.delete(CART_COOKIE_NAME, { path: CART_COOKIE_PATH });
	clearCheckoutCookie(ctx.cookies);
}

/** The cart the cookie names, or null when there is none or it cannot be read. */
async function readCookieCart(
	ctx: CartCookieContext,
	cartId: string,
): Promise<{ orderId: string | null } | null> {
	const result = await dispatchOttaRoute<CartReadRouteResult>(
		ctx.handler,
		STOREFRONT_CART_READ_ROUTE,
		{ cartId },
		ctx.url,
	);
	return result !== null && result.ok ? result.cart : null;
}

/**
 * The ORDER CONFIRMATION page's half: the page already holds the order, so this
 * costs one cart read — and only when the order has left `pending` and a cart
 * cookie is present. Returns whether the cart was forgotten.
 */
export async function forgetSpentCart(
	ctx: CartCookieContext,
	order: { id: string; state: string },
): Promise<boolean> {
	if (order.state === "pending") return false;
	const cartId = cookieCartId(ctx);
	if (cartId === undefined) return false;
	const cart = await readCookieCart(ctx, cartId);
	if (cart === null || !isSpentCart(cart, order)) return false;
	forget(ctx);
	return true;
}

/**
 * `/cart/add`'s half, reached only when an add was refused CART_CHECKED_OUT: read
 * the cart for the order it became, read that order's state, and forget the cart
 * if it is spent. Two reads, on a path that was an error page before.
 */
export async function forgetCheckedOutCart(
	ctx: CartCookieContext,
	cartId: string,
): Promise<boolean> {
	const cart = await readCookieCart(ctx, cartId);
	if (cart === null || cart.orderId === null) return false;
	const result = await dispatchOttaRoute<OrderRouteResult>(
		ctx.handler,
		STOREFRONT_ORDER_ROUTE,
		{ orderId: cart.orderId },
		ctx.url,
	);
	if (result === null || !result.ok || !isSpentCart(cart, result.order)) return false;
	forget(ctx);
	return true;
}
