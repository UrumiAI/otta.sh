/**
 * Storefront customer account — PLUGIN-OWNED PUBLIC ROUTES (Phase 5 §9, shape
 * per ADR-0003 and the cart-routes precedent). Thin, HTTP-only: each route
 * validates input → `HttpCommerceClient` call over `ctx.http` → serialize the
 * (already-typed) result. The plugin holds NO customer/session state.
 *
 * ── Platform-verified deviation from plan §4's session-cookie wording ──────
 * Plan §4 has the plugin route set/read the session cookie directly. That is
 * DISPROVEN by the same em-dash platform verification already documented in
 * `cart-routes.ts`: sandboxed-plugin routes are cookie-blind in BOTH directions
 * — `apiSuccess`/`res.json()` (`packages/core/src/api/error.ts`,
 * `packages/workerd/src/sandbox/runner.ts`) give a route no channel to emit
 * `Set-Cookie`, and `sanitizeHeadersForSandbox`
 * (`packages/core/src/plugins/request-meta.ts`) strips `cookie`/`set-cookie`
 * from the inbound headers. So, exactly like cart-routes:
 *   - login/verify returns a session-cookie DESCRIPTOR for the theme's
 *     first-party Astro layer to apply on ITS OWN response (`Astro.cookies.set`);
 *   - every authenticated route takes `sessionToken` as plain route input (the
 *     theme shim reads its own cookie and passes the value through), never a
 *     cookie the sandbox can read.
 * The service remains the sole authority on identity — it derives `customerId`
 * from the bearer token (§4); this layer only transports it.
 */
import { COMMERCE_SERVICE_BASE_URL, serviceTokenFromKv } from "../manifest.js";
import type { AddressWire, OrderSummaryWire } from "../product-commerce/commerce-client.js";
import { HttpCommerceClient } from "../product-commerce/http-commerce-client.js";
import type { PluginContext, RouteHandler } from "../types.js";
import { renderGuard } from "./pdp-route.js";

// ── Public route names ──────────────────────────────────────────────────
export const ACCOUNT_LOGIN_REQUEST_ROUTE = "storefront/account/login/request";
export const ACCOUNT_LOGIN_VERIFY_ROUTE = "storefront/account/login/verify";
export const ACCOUNT_ORDERS_ROUTE = "storefront/account/orders";
export const ACCOUNT_ORDER_ROUTE = "storefront/account/order";
export const ACCOUNT_ADDRESSES_ROUTE = "storefront/account/addresses";

/** Where an unauthenticated account request is redirected. */
export const ACCOUNT_LOGIN_PATH = "/account/login";
/** Where a successful login lands. */
export const ACCOUNT_ORDERS_PATH = "/account/orders";

/** The session-cookie name — one constant so the descriptor and the theme
 *  shim's read side never drift. */
export const SESSION_COOKIE_NAME = "otta_session";

/** The session-cookie INTENT descriptor a login route returns for the theme
 *  shim to apply on its own response (see module doc). */
export interface SessionCookieDescriptor {
	name: string;
	value: string;
	httpOnly: true;
	secure: true;
	sameSite: "lax";
	path: string;
	/** Absolute expiry (ISO-8601) mirroring the session's own `expiresAt`. */
	expiresAt: string;
}

function sessionCookieDescriptor(token: string, expiresAt: string): SessionCookieDescriptor {
	return {
		name: SESSION_COOKIE_NAME,
		value: token,
		httpOnly: true,
		secure: true,
		sameSite: "lax",
		path: "/",
		expiresAt,
	};
}

/** Async because it awaits the write-gate token from write-only kv (ADR-0007).
 *  The login pre-auth calls (`/auth/login/request`, `/auth/login/verify`) and
 *  `logout` are POSTs the service gate blocks without `X-Service-Token`; the
 *  `/me/*` reads carry it harmlessly alongside the session Bearer. Undefined ⇒
 *  no header ⇒ byte-identical to the pre-gate wire. */
async function createCommerceClient(ctx: PluginContext): Promise<HttpCommerceClient> {
	const serviceToken = await serviceTokenFromKv(ctx);
	return new HttpCommerceClient({
		fetch: ctx.http.fetch,
		baseUrl: COMMERCE_SERVICE_BASE_URL,
		...(serviceToken !== undefined ? { serviceToken } : {}),
	});
}

/** Exported for reuse (e.g. `entitlements/download-route.ts`) rather than each
 *  route re-inlining the same `typeof value === "string" && value.length > 0`
 *  guard. `cart-routes.ts` keeps its own copy (pre-existing, out of scope here). */
export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

// ── Input / result shapes (hand-validated — the routes are PUBLIC) ─────────

export interface AccountLoginRequestInput {
	email?: unknown;
}
export type AccountLoginRequestResult =
	| { ok: true }
	| { ok: false; error: "INVALID_INPUT" }
	| { ok: false; error: "RENDER_FAILED" };

export interface AccountLoginVerifyInput {
	challengeId?: unknown;
	token?: unknown;
}
export type AccountLoginVerifyResult =
	| { ok: true; cookie: SessionCookieDescriptor; redirectTo: string }
	| { ok: false; error: "INVALID_INPUT" }
	| { ok: false; reason: "EXPIRED" | "INVALID" | "CONSUMED" }
	| { ok: false; error: "RENDER_FAILED" };

export interface AccountSessionInput {
	sessionToken?: unknown;
}
export type AccountOrdersResult =
	| { ok: true; orders: OrderSummaryWire[] }
	| { ok: false; redirectTo: string }
	| { ok: false; error: "RENDER_FAILED" };

export interface AccountOrderInput {
	sessionToken?: unknown;
	orderId?: unknown;
}
export type AccountOrderResult =
	| { ok: true; order: OrderSummaryWire }
	| { ok: false; error: "NOT_FOUND" }
	| { ok: false; redirectTo: string }
	| { ok: false; error: "RENDER_FAILED" };

export type AccountAddressesResult =
	| { ok: true; addresses: AddressWire[] }
	| { ok: false; redirectTo: string }
	| { ok: false; error: "RENDER_FAILED" };

/** `POST /auth/login/request` proxy — generic success regardless of account
 *  existence (§9 Risk 4). */
export function createAccountLoginRequestHandler(): RouteHandler<AccountLoginRequestInput> {
	return (routeCtx, ctx): Promise<AccountLoginRequestResult> =>
		renderGuard(ACCOUNT_LOGIN_REQUEST_ROUTE, async () => {
			const email = routeCtx.input.email;
			if (!isNonEmptyString(email)) return { ok: false, error: "INVALID_INPUT" } as const;
			await (await createCommerceClient(ctx)).requestLoginLink(email);
			return { ok: true as const };
		});
}

/** `POST /auth/login/verify` proxy — on success returns the session-cookie
 *  descriptor + redirect for the theme shim to apply. */
export function createAccountLoginVerifyHandler(): RouteHandler<AccountLoginVerifyInput> {
	return (routeCtx, ctx): Promise<AccountLoginVerifyResult> =>
		renderGuard(ACCOUNT_LOGIN_VERIFY_ROUTE, async () => {
			const { challengeId, token } = routeCtx.input;
			if (!isNonEmptyString(challengeId) || !isNonEmptyString(token)) {
				return { ok: false, error: "INVALID_INPUT" } as const;
			}
			const result = await (await createCommerceClient(ctx)).verifyLogin(challengeId, token);
			if (!result.ok) return { ok: false as const, reason: result.reason };
			return {
				ok: true as const,
				cookie: sessionCookieDescriptor(result.sessionToken, result.expiresAt),
				redirectTo: ACCOUNT_ORDERS_PATH,
			};
		});
}

/** `GET /me/orders` proxy — unauthenticated ⇒ redirect to login (never a leak). */
export function createAccountOrdersHandler(): RouteHandler<AccountSessionInput> {
	return (routeCtx, ctx): Promise<AccountOrdersResult> =>
		renderGuard(ACCOUNT_ORDERS_ROUTE, async () => {
			const sessionToken = routeCtx.input.sessionToken;
			if (!isNonEmptyString(sessionToken)) {
				return { ok: false as const, redirectTo: ACCOUNT_LOGIN_PATH };
			}
			const result = await (await createCommerceClient(ctx)).listMyOrders(sessionToken);
			if (!result.ok) return { ok: false as const, redirectTo: ACCOUNT_LOGIN_PATH };
			return { ok: true as const, orders: result.orders };
		});
}

/** `GET /me/orders/:id` proxy — a foreign/unknown id is `NOT_FOUND` (404 at the
 *  service — no existence leak), distinct from the unauthenticated redirect. */
export function createAccountOrderHandler(): RouteHandler<AccountOrderInput> {
	return (routeCtx, ctx): Promise<AccountOrderResult> =>
		renderGuard(ACCOUNT_ORDER_ROUTE, async () => {
			const { sessionToken, orderId } = routeCtx.input;
			if (!isNonEmptyString(sessionToken)) {
				return { ok: false as const, redirectTo: ACCOUNT_LOGIN_PATH };
			}
			if (!isNonEmptyString(orderId)) return { ok: false as const, error: "NOT_FOUND" };
			const result = await (await createCommerceClient(ctx)).getMyOrder(sessionToken, orderId);
			if (result.ok) return { ok: true as const, order: result.order };
			if (result.reason === "NOT_FOUND") return { ok: false as const, error: "NOT_FOUND" };
			return { ok: false as const, redirectTo: ACCOUNT_LOGIN_PATH };
		});
}

/** `GET /me/addresses` proxy — same auth-gated shape. */
export function createAccountAddressesHandler(): RouteHandler<AccountSessionInput> {
	return (routeCtx, ctx): Promise<AccountAddressesResult> =>
		renderGuard(ACCOUNT_ADDRESSES_ROUTE, async () => {
			const sessionToken = routeCtx.input.sessionToken;
			if (!isNonEmptyString(sessionToken)) {
				return { ok: false as const, redirectTo: ACCOUNT_LOGIN_PATH };
			}
			const result = await (await createCommerceClient(ctx)).listMyAddresses(sessionToken);
			if (!result.ok) return { ok: false as const, redirectTo: ACCOUNT_LOGIN_PATH };
			return { ok: true as const, addresses: result.addresses };
		});
}
