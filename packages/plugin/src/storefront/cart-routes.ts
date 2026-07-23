/**
 * Cart — PLUGIN-OWNED PUBLIC ROUTES (Phase 3 group E, plan §7 step E1, shape
 * per ADR-0003). The plugin holds no cart/stock state (plan §4 "Where cart
 * state lives"): every route here is a straight proxy over `ctx.http` to
 * `@urumi/service`'s `/carts` REST surface — validate input → `HttpCommerceClient`
 * call → serialize the (already-typed) result. No cart truth is duplicated
 * or cached in the plugin.
 *
 * ── Platform-verified deviation from plan §4's literal wording ────────────
 * Plan §4 says "The plugin storefront route sets [cartId] as a cookie:
 * httpOnly, Secure, SameSite=Lax". Verified against the em-dash platform
 * source (the same class of verification that produced ADR-0003):
 *   - Every sandboxed-plugin route response is constructed by
 *     `apiSuccess(result.data)` (`packages/core/src/api/error.ts`), which
 *     ALWAYS emits `Response.json({data}, {headers: API_CACHE_HEADERS})` — a
 *     fixed header set. A route handler's return value is serialized to
 *     plain JSON (`packages/workerd/src/sandbox/runner.ts`'s
 *     `invokeRoute`/`res.json()`); there is no channel back to the outer
 *     HTTP response for extra headers, so a route CANNOT emit `Set-Cookie`.
 *   - The inbound direction is blocked too, deliberately: `sanitizeHeadersForSandbox`
 *     (`packages/core/src/plugins/request-meta.ts`) strips both `cookie` and
 *     `set-cookie` from every header set handed to a sandboxed plugin, "to
 *     prevent malicious plugins from exfiltrating sensitive data" — so a
 *     route cannot even READ the browser's `Cookie` header.
 * Sandboxed plugin routes are cookie-blind in both directions, by explicit
 * platform design — not an oversight this phase can route around. This
 * mirrors ADR-0003's own resolution: the plugin's public routes are pure
 * JSON view models; a first-party layer with real `Response` control (the
 * theme's Astro page, same as ADR-0003's PDP/PLP shim) is what actually
 * calls `Astro.cookies.set(...)`/reads `Astro.cookies.get(...)`. So:
 *   - `cart/create`'s result carries a `cookie` DESCRIPTOR — the intended
 *     name/value/attributes — for the theme shim to apply on ITS OWN
 *     response. The plugin expresses cart-cookie INTENT; it cannot enact it.
 *   - Every other cart route takes `cartId` as plain route input (the theme
 *     shim reads its own cookie and passes the value through), exactly like
 *     PDP/PLP already take `content`/`items` as input (route-input.ts).
 * Flagged in the PR/report as a should-fix for plan §4 (and, transitively,
 * Phase 5's session-cookie design, which makes the same now-disproven
 * assumption) — a candidate follow-up ADR, not resolved here.
 */
import { COMMERCE_SERVICE_BASE_URL, serviceTokenFromKv } from "../manifest.js";
import type {
	CartFailureReason,
	CartLineWire,
	CartResult,
	CartWire,
} from "../product-commerce/commerce-client.js";
import { HttpCommerceClient } from "../product-commerce/http-commerce-client.js";
import type { PluginContext, RouteHandler } from "../types.js";
import { renderGuard } from "./pdp-route.js";

// ── Public route names ──────────────────────────────────────────────────
export const STOREFRONT_CART_CREATE_ROUTE = "storefront/cart/create";
export const STOREFRONT_CART_READ_ROUTE = "storefront/cart/read";
export const STOREFRONT_CART_LINE_ADD_ROUTE = "storefront/cart/lines/add";
export const STOREFRONT_CART_LINE_UPDATE_ROUTE = "storefront/cart/lines/update";
export const STOREFRONT_CART_LINE_REMOVE_ROUTE = "storefront/cart/lines/remove";

/** The cart-cookie name — a single constant so the plugin's descriptor and
 *  (documentation for) the theme shim's read side never drift. */
export const CART_COOKIE_NAME = "urumi_cart";

/** 30 days — not specified by the plan (only the hold TTL, 15 min, is); a
 *  reasonable default for how long an anonymous cart pointer survives. The
 *  CART itself has no TTL (only its held LINES do, via `expiresAt`); an
 *  abandoned cart just accumulates no lines once its holds are swept. */
const CART_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** The cookie-setting INTENT descriptor a route returns in its JSON body —
 *  see the module doc's platform-verified deviation note. `path: "/"`
 *  because the plugin has no visibility into the theme's route layout
 *  (plan §4 says "path-scoped to the storefront", but the plugin cannot
 *  itself know that path; the theme shim, which DOES know its own routes,
 *  may narrow it when applying the cookie). */
export interface CartCookieDescriptor {
	name: string;
	value: string;
	httpOnly: true;
	secure: true;
	sameSite: "lax";
	path: string;
	maxAgeSeconds: number;
}

function cartCookieDescriptor(cartId: string): CartCookieDescriptor {
	return {
		name: CART_COOKIE_NAME,
		value: cartId,
		httpOnly: true,
		secure: true,
		sameSite: "lax",
		path: "/",
		maxAgeSeconds: CART_COOKIE_MAX_AGE_SECONDS,
	};
}

/** One client per invocation (matches `createCommerceLoader`'s
 *  request-scoped lifecycle, pdp-route.ts) — no cross-request state. Async
 *  because it awaits the write-gate token from write-only kv (ADR-0007): the
 *  cart writes (create/add/adjust/remove) are non-GETs the service gate blocks
 *  without `X-Service-Token`. Undefined ⇒ no header ⇒ pre-gate wire. */
async function createCommerceClient(ctx: PluginContext): Promise<HttpCommerceClient> {
	const serviceToken = await serviceTokenFromKv(ctx);
	return new HttpCommerceClient({
		fetch: ctx.http.fetch,
		baseUrl: COMMERCE_SERVICE_BASE_URL,
		...(serviceToken !== undefined ? { serviceToken } : {}),
	});
}

// ── Input shapes (hand-validated — the routes are PUBLIC, ADR-0003) ───────

export interface CartCreateRouteInput {
	currency?: unknown;
}

export interface CartReadRouteInput {
	cartId?: unknown;
}

export interface CartLineAddRouteInput {
	cartId?: unknown;
	sku?: unknown;
	/** The CMS content id (the join key to `product_commerce`), threaded from the
	 *  PDP add-to-cart slot so the line is priceable/quotable/orderable — issue
	 *  #80. Optional for backward-compat with a bare (legacy) add; when present it
	 *  must be a non-empty string, and it flows to the service `addLine` call. */
	productId?: unknown;
	qty?: unknown;
	/** Fresh per user action (plan §8 Risk 8) — the Block Kit add-to-cart
	 *  affordance embeds one at render time; the caller forwards it verbatim
	 *  as `Idempotency-Key`. The plugin never invents or reuses a key. */
	idempotencyKey?: unknown;
}

export interface CartLineUpdateRouteInput {
	cartId?: unknown;
	lineId?: unknown;
	qty?: unknown;
	idempotencyKey?: unknown;
}

export interface CartLineRemoveRouteInput {
	cartId?: unknown;
	lineId?: unknown;
	idempotencyKey?: unknown;
}

export type CartCreateRouteResult =
	| { ok: true; cartId: string; cookie: CartCookieDescriptor }
	| { ok: false; error: "INVALID_CURRENCY" }
	| { ok: false; error: "RENDER_FAILED" };

export type CartReadRouteResult =
	| { ok: true; cart: CartWire }
	| { ok: false; error: "INVALID_CART_ID" }
	| { ok: false; reason: CartFailureReason }
	| { ok: false; error: "RENDER_FAILED" };

export type CartLineMutationRouteResult<T> =
	| ({ ok: true } & T)
	| { ok: false; error: "INVALID_INPUT" }
	| { ok: false; reason: CartFailureReason }
	| { ok: false; error: "RENDER_FAILED" };

/** Not `CartLineMutationRouteResult<Record<string, never>>` — intersecting
 *  `{ok:true}` with an index-signature "empty object" type rejects `ok`'s
 *  own key under the signature's `never` value type. A plain success
 *  variant (no extra fields) sidesteps that. */
export type CartLineRemoveRouteResult =
	| { ok: true }
	| { ok: false; error: "INVALID_INPUT" }
	| { ok: false; reason: CartFailureReason }
	| { ok: false; error: "RENDER_FAILED" };

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isPositiveInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * `POST /carts` proxy — mints a fresh anonymous cart and returns its id
 * plus the cookie descriptor the theme shim applies (see module doc).
 */
export function createCartCreateRouteHandler(): RouteHandler<CartCreateRouteInput> {
	return (routeCtx, ctx): Promise<CartCreateRouteResult> =>
		renderGuard(STOREFRONT_CART_CREATE_ROUTE, async () => {
			const raw = routeCtx.input.currency;
			if (raw !== undefined && (typeof raw !== "string" || !CURRENCY_PATTERN.test(raw))) {
				return { ok: false, error: "INVALID_CURRENCY" } as const;
			}
			const client = await createCommerceClient(ctx);
			const { cartId } = await client.createCart(raw as string | undefined);
			return { ok: true as const, cartId, cookie: cartCookieDescriptor(cartId) };
		});
}

/**
 * `GET /carts/:cartId` proxy — live cart (server-side lazy-expiry already
 * ran); `cartId` arrives as route input, read by the caller from its own
 * cookie (see module doc's platform-verified deviation).
 *
 * No price/totals join here yet (a documented follow-up, not closed by issue
 * #80's fix): the cart-line wire now DOES carry a `productId` (the add-line
 * path threads it through `addLineBody` → the service's `addLine`, so the line
 * can be priced/quoted/ordered), but `GET /carts/:cartId` still returns only
 * `{ sku, productId, qty, … }` — it does not join `product_commerce` to attach
 * a live price. The plugin's commerce lookups (`getCommerceBatch`/
 * `getProductCommerce`) ARE keyed by `productId`, so a price-annotated cart read
 * is now REACHABLE (batch-load the lines' productIds); it is deferred as a
 * separate `[Service]`/`[Plugin]` follow-up (join in `GET /carts/:cartId`, or a
 * plugin-side batch join) to keep issue #80 scoped to the checkout-blocking
 * thread. `totalQty` remains the one total honestly computable from the wire as
 * returned today — no price is ever fabricated (CLAUDE.md).
 */
export function createCartReadRouteHandler(): RouteHandler<CartReadRouteInput> {
	return (routeCtx, ctx): Promise<CartReadRouteResult> =>
		renderGuard(STOREFRONT_CART_READ_ROUTE, async () => {
			const cartId = routeCtx.input.cartId;
			if (!isNonEmptyString(cartId)) return { ok: false, error: "INVALID_CART_ID" } as const;

			const client = await createCommerceClient(ctx);
			const result = await client.getCart(cartId);
			if (!result.ok) return { ok: false as const, reason: result.reason };
			return { ok: true as const, cart: result.cart };
		});
}

/** Sum of line quantities — the one cart "total" computable without a live
 *  price join (see `createCartReadRouteHandler`'s doc). Exported so a theme
 *  shim (or a test) can derive it from a `CartWire` without re-deriving the
 *  reduction by hand. */
export function totalQty(cart: CartWire): number {
	return cart.lines.reduce((sum, line) => sum + line.qty, 0);
}

/** `POST /carts/:cartId/lines` proxy. */
export function createCartLineAddRouteHandler(): RouteHandler<CartLineAddRouteInput> {
	return (routeCtx, ctx): Promise<CartLineMutationRouteResult<{ line: CartLineWire }>> =>
		renderGuard(STOREFRONT_CART_LINE_ADD_ROUTE, async () => {
			const { cartId, sku, productId, qty, idempotencyKey } = routeCtx.input;
			// `productId` is OPTIONAL (bare/legacy add) but, when present, must be a
			// non-empty string — a present-but-blank value is a validation reject,
			// never silently dropped (issue #80). Absent ⇒ null on the wire.
			if (
				!isNonEmptyString(cartId) ||
				!isNonEmptyString(sku) ||
				(productId !== undefined && !isNonEmptyString(productId)) ||
				!isPositiveInt(qty) ||
				!isNonEmptyString(idempotencyKey)
			) {
				return { ok: false, error: "INVALID_INPUT" } as const;
			}
			const client = await createCommerceClient(ctx);
			const result: CartResult<{ line: CartLineWire }> = await client.addCartLine(
				cartId,
				sku,
				productId ?? null,
				qty,
				idempotencyKey,
			);
			if (!result.ok) return { ok: false as const, reason: result.reason };
			return { ok: true as const, line: result.line };
		});
}

/** `PATCH /carts/:cartId/lines/:lineId` proxy — target qty, not a delta (the
 *  service computes the delta; see `HttpCommerceClient.adjustCartLine`). */
export function createCartLineUpdateRouteHandler(): RouteHandler<CartLineUpdateRouteInput> {
	return (routeCtx, ctx): Promise<CartLineMutationRouteResult<{ line: CartLineWire }>> =>
		renderGuard(STOREFRONT_CART_LINE_UPDATE_ROUTE, async () => {
			const { cartId, lineId, qty, idempotencyKey } = routeCtx.input;
			if (
				!isNonEmptyString(cartId) ||
				!isNonEmptyString(lineId) ||
				!isPositiveInt(qty) ||
				!isNonEmptyString(idempotencyKey)
			) {
				return { ok: false, error: "INVALID_INPUT" } as const;
			}
			const client = await createCommerceClient(ctx);
			const result: CartResult<{ line: CartLineWire }> = await client.adjustCartLine(
				cartId,
				lineId,
				qty,
				idempotencyKey,
			);
			if (!result.ok) return { ok: false as const, reason: result.reason };
			return { ok: true as const, line: result.line };
		});
}

/** `DELETE /carts/:cartId/lines/:lineId` proxy. */
export function createCartLineRemoveRouteHandler(): RouteHandler<CartLineRemoveRouteInput> {
	return (routeCtx, ctx): Promise<CartLineRemoveRouteResult> =>
		renderGuard(STOREFRONT_CART_LINE_REMOVE_ROUTE, async () => {
			const { cartId, lineId, idempotencyKey } = routeCtx.input;
			if (
				!isNonEmptyString(cartId) ||
				!isNonEmptyString(lineId) ||
				!isNonEmptyString(idempotencyKey)
			) {
				return { ok: false, error: "INVALID_INPUT" } as const;
			}
			const client = await createCommerceClient(ctx);
			const result: CartResult<Record<string, never>> = await client.removeCartLine(
				cartId,
				lineId,
				idempotencyKey,
			);
			if (!result.ok) return { ok: false as const, reason: result.reason };
			return { ok: true as const };
		});
}
