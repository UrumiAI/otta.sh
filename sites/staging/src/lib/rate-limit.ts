/**
 * Per-IP rate limiting on the anonymous write surface and the login requests
 * (issues #91 and #29; ADR-0004's per-IP prerequisite for customer login).
 *
 * WHAT. Two Cloudflare Workers Rate Limiting bindings, one per CLASS, checked
 * by `src/middleware.ts` before any endpoint runs:
 *  - `auth` (tighter): the sign-in link request, the sign-in confirm, and the
 *    order-resume step that takes an email as its second factor. Each is a
 *    guessing or mail-sending surface; the per-address throttle cannot stop
 *    one client cycling addresses (or holding a victim's window full).
 *  - `writes`: everything that mints or changes a cart, places an order or
 *    abandons one.
 * The key is the class plus the client's network: `CF-Connecting-IP` as is for
 * IPv4, its /64 for IPv6 (one subscriber usually holds a whole /64, so keying
 * the full address would hand an attacker 2^64 keys).
 *
 * WHICH ROUTES. The site's own form endpoints, keyed by the ROUTE Astro matched
 * (`routePattern`, as the origin guard does, so a trailing slash or an encoded
 * letter cannot step around it), on non-safe methods only — except
 * `/checkout/resume`, whose GET (the order page's "Complete payment" link)
 * dispatches the same plugin resume step its POST does, so it counts on every
 * method but OPTIONS, as that step does on the plugin mount — except a GET/HEAD
 * the handler answers without the plugin (cross-site navigation, no `?order=`),
 * which is not counted. And the plugin's
 * public routes on the wire mount `/_emdash/api/plugins/otta/<route>`, matched
 * on the decoded path — on EVERY method but OPTIONS, because EmDash's plugin
 * dispatcher answers GET and HEAD too, reading the input from the query
 * string: a GET to `storefront/cart/create` mints a cart just as a POST does.
 *
 * NOT DOUBLE-COUNTED. The site's endpoints reach the plugin IN-PROCESS
 * (`lib/otta-api.ts`: `handlePublicPluginApiRoute` with a synthetic Request),
 * which never passes through this middleware. So a shopper's `/cart/add` is
 * counted once, under the site route; only a client calling the plugin mount
 * directly is counted there.
 *
 * FAIL OPEN. No binding (local dev, the unit tests, the playground, or a
 * deployer who has not added it — DEPLOYMENT.md §2.5), no usable client IP,
 * or a binding call that throws: the request proceeds. A missing binding is
 * logged once per class per isolate. The limiter is a blunting measure, not a
 * correctness gate, so it must never take checkout down with it. Cloudflare's
 * binding is also approximate by design (counted per location, eventually
 * consistent): treat the limits as ceilings on abuse, not exact quotas.
 */
import {
	ACCOUNT_ADDRESSES_ROUTE,
	ACCOUNT_LOGIN_REQUEST_ROUTE,
	ACCOUNT_LOGIN_VERIFY_ROUTE,
	ACCOUNT_LOGOUT_ROUTE,
	ACCOUNT_ME_ROUTE,
	ACCOUNT_ORDER_ROUTE,
	ACCOUNT_ORDERS_ROUTE,
	ENTITLEMENT_DOWNLOAD_ROUTE,
	OTTA_PLUGIN_ID,
	STOREFRONT_CART_CREATE_ROUTE,
	STOREFRONT_CART_LINE_ADD_ROUTE,
	STOREFRONT_CART_LINE_REMOVE_ROUTE,
	STOREFRONT_CART_LINE_UPDATE_ROUTE,
	STOREFRONT_CART_READ_ROUTE,
	STOREFRONT_CHECKOUT_PLACE_ROUTE,
	STOREFRONT_CHECKOUT_SUMMARY_ROUTE,
	STOREFRONT_LIST_ROUTE,
	STOREFRONT_ORDER_ABANDON_ROUTE,
	STOREFRONT_ORDER_RESUME_ROUTE,
	STOREFRONT_ORDER_ROUTE,
	STOREFRONT_PAYMENT_CONFIG_ROUTE,
	STOREFRONT_PRODUCT_ROUTE,
	STOREFRONT_SHOPPER_STATE_ROUTE,
	STRIPE_WEBHOOK_SETTLE_ROUTE,
} from "@urumi.ai/otta-plugin";
import { isCrossSiteNavigation, orderPathFor } from "./checkout-resume.js";
import { PRIVATE_NO_STORE } from "./no-store.js";
import { SAFE_METHODS } from "./origin-guard.js";

export type RateLimitClass = "auth" | "writes";

/** The Worker binding each class reads (`ratelimits[].name` in wrangler config). */
export const RATE_LIMIT_BINDINGS: Readonly<Record<RateLimitClass, string>> = {
	auth: "RATE_LIMIT_AUTH",
	writes: "RATE_LIMIT_WRITES",
};

/**
 * `Retry-After` per class: the binding's `period`, in seconds. The LIMITS
 * themselves live only in the binding's config (`ratelimits[].simple`, see
 * DEPLOYMENT.md §2.5 and the commented template in wrangler.jsonc) — the
 * binding enforces them and the site never reads them. Change a `period`
 * there and this must change with it (the binding accepts 10 or 60).
 * `test/rate-limit.test.ts` pins the template and the runbook to this table.
 */
export const RETRY_AFTER_SECONDS: Readonly<Record<RateLimitClass, 10 | 60>> = {
	auth: 60,
	writes: 60,
};

/** A protected site endpoint: its class, whether its GET counts too, and
 *  where the 429 page's "Go back" link points. */
interface SiteRoute {
	readonly cls: RateLimitClass;
	readonly anyMethod?: true;
	readonly backTo: string;
}

/** Site endpoints (Astro route patterns), non-safe methods only unless
 *  `anyMethod`. */
export const SITE_ROUTES: ReadonlyMap<string, SiteRoute> = new Map<string, SiteRoute>([
	["/account/login/request", { cls: "auth", backTo: "/account/login" }],
	["/account/verify/confirm", { cls: "auth", backTo: "/account/login" }],
	["/checkout/resume", { cls: "auth", anyMethod: true, backTo: "/cart" }],
	["/cart/add", { cls: "writes", backTo: "/cart" }],
	["/cart/update", { cls: "writes", backTo: "/cart" }],
	["/cart/remove", { cls: "writes", backTo: "/cart" }],
	["/cart/switch-currency", { cls: "writes", backTo: "/cart" }],
	["/checkout/place", { cls: "writes", backTo: "/cart" }],
	["/checkout/new-cart", { cls: "writes", backTo: "/cart" }],
]);

/** The plugin's public routes, on its wire mount — every method but OPTIONS. */
export const PLUGIN_ROUTES: ReadonlyMap<string, RateLimitClass> = new Map([
	[ACCOUNT_LOGIN_REQUEST_ROUTE, "auth"],
	[ACCOUNT_LOGIN_VERIFY_ROUTE, "auth"],
	[STOREFRONT_ORDER_RESUME_ROUTE, "auth"],
	[STOREFRONT_CART_CREATE_ROUTE, "writes"],
	[STOREFRONT_CART_LINE_ADD_ROUTE, "writes"],
	[STOREFRONT_CART_LINE_UPDATE_ROUTE, "writes"],
	[STOREFRONT_CART_LINE_REMOVE_ROUTE, "writes"],
	[STOREFRONT_CHECKOUT_PLACE_ROUTE, "writes"],
	[STOREFRONT_ORDER_ABANDON_ROUTE, "writes"],
]);

/**
 * Site write endpoints deliberately NOT limited, each with its reason. Every
 * route under `src/pages` that exports a write handler is in `SITE_ROUTES` or
 * here — `test/rate-limit.test.ts` fails on one in neither (default-deny, as
 * `ORIGIN_GUARD_EXEMPT_ROUTES` does for the origin check).
 */
export const RATE_LIMIT_EXEMPT_SITE_ROUTES: ReadonlyMap<string, string> = new Map([
	["/account/logout", "ends the caller's own session; mints nothing, sends nothing"],
	[
		"/webhooks/stripe",
		"Stripe-signed server-to-server delivery; refusing one could leave a paid order unsettled",
	],
	["/otta-admin/downloads/[productId]", "store admins only (EmDash session and role check)"],
]);

/** The plugin's PUBLIC routes deliberately NOT limited, each with its reason —
 *  the same default-deny pin over the plugin's route table. */
export const RATE_LIMIT_EXEMPT_PLUGIN_ROUTES: ReadonlyMap<string, string> = new Map([
	[STOREFRONT_PRODUCT_ROUTE, "read: creates nothing, sends nothing"],
	[STOREFRONT_LIST_ROUTE, "read: creates nothing, sends nothing"],
	[STOREFRONT_CART_READ_ROUTE, "read: creates nothing, sends nothing"],
	[STOREFRONT_CHECKOUT_SUMMARY_ROUTE, "read: creates nothing, sends nothing"],
	[STOREFRONT_ORDER_ROUTE, "read: creates nothing, sends nothing"],
	[STOREFRONT_PAYMENT_CONFIG_ROUTE, "read: the publishable key only"],
	[STOREFRONT_SHOPPER_STATE_ROUTE, "read: creates nothing, sends nothing"],
	[ENTITLEMENT_DOWNLOAD_ROUTE, "re-checks the buyer's entitlement on every download"],
	[STRIPE_WEBHOOK_SETTLE_ROUTE, "Stripe-signed; refusing one could leave a paid order unsettled"],
	[ACCOUNT_ORDERS_ROUTE, "answers only for a valid session token"],
	[ACCOUNT_ORDER_ROUTE, "answers only for a valid session token"],
	[ACCOUNT_ADDRESSES_ROUTE, "answers only for a valid session token"],
	[ACCOUNT_LOGOUT_ROUTE, "ends the caller's own session"],
	[ACCOUNT_ME_ROUTE, "answers only for a valid session token"],
]);

const PLUGIN_MOUNT = `/_emdash/api/plugins/${OTTA_PLUGIN_ID}/`;

/** The plugin route a path names, decoded, repeated slashes collapsed and a
 *  trailing slash dropped — over-matching only ever counts a request that
 *  would 404, never lets a real one through. `null` off the Otta mount. */
function pluginRouteOf(url: URL): string | null {
	let path = url.pathname;
	try {
		path = decodeURIComponent(path);
	} catch {
		// An undecodable path is matched raw.
	}
	path = path.replace(/\/{2,}/g, "/");
	if (!path.startsWith(PLUGIN_MOUNT)) return null;
	return path.slice(PLUGIN_MOUNT.length).replace(/\/+$/, "");
}

const RESUME_ROUTE = "/checkout/resume";

/** The order id `/checkout/resume?order=` names, trimmed; "" when absent. */
function resumeOrderParam(url: URL): string {
	return url.searchParams.get("order")?.trim() ?? "";
}

/**
 * Pure decision (unit-tested): the class this request is counted in, or null.
 * `request` supplies the `Sec-Fetch-Site` header: a GET/HEAD `/checkout/resume`
 * that the handler answers without reaching the plugin (a cross-site
 * navigation, or no `?order=`) is not counted, so a third-party page cannot
 * spend a visitor's auth budget with `<img>` tags.
 */
export function rateLimitClassFor(
	method: string,
	url: URL,
	routePattern: string,
	request?: Pick<Request, "headers">,
): RateLimitClass | null {
	const verb = method.toUpperCase();
	const pluginRoute = pluginRouteOf(url);
	if (pluginRoute !== null) {
		if (verb === "OPTIONS") return null;
		return PLUGIN_ROUTES.get(pluginRoute) ?? null;
	}
	const site = SITE_ROUTES.get(routePattern);
	if (site === undefined) return null;
	if (site.anyMethod === true ? verb === "OPTIONS" : SAFE_METHODS.has(verb)) return null;
	if (routePattern === RESUME_ROUTE && SAFE_METHODS.has(verb)) {
		if (resumeOrderParam(url) === "") return null;
		if (request !== undefined && isCrossSiteNavigation(request)) return null;
	}
	return site.cls;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET = /^[0-9a-f]{1,4}$/;
/** The NAT64 well-known prefix (RFC 6052): `64:ff9b::/96` carries an IPv4 host. */
const NAT64 = ["64", "ff9b", "0", "0", "0", "0"];

/** The longest raw value keyed when an address does not parse. */
const RAW_KEY_MAX = 64;

function isIpv4(value: string): boolean {
	const octets = IPV4.exec(value);
	return octets !== null && octets.slice(1).every((octet) => Number(octet) <= 255);
}

/** An IPv6 address as its eight groups (numbers), dotted IPv4 tails included;
 *  null when it does not parse. */
function ipv6Groups(value: string): number[] | null {
	let text = value;
	const tail: string[] = [];
	const lastColon = text.lastIndexOf(":");
	const last = text.slice(lastColon + 1);
	if (last.includes(".")) {
		if (!isIpv4(last)) return null;
		const [a, b, c, d] = last.split(".").map(Number) as [number, number, number, number];
		tail.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
		// Drop the dotted tail: `x::a.b.c.d` leaves `x::`, `x:y:a.b.c.d` leaves `x:y`.
		text = text.slice(0, lastColon + 1);
		if (!text.endsWith("::")) text = text.slice(0, -1);
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
	const rest = halves.length === 2 && halves[1] !== "" ? (halves[1] ?? "").split(":") : [];
	const after = [...rest, ...tail];
	const groups =
		halves.length === 2
			? [...head, ...Array<string>(Math.max(0, 8 - head.length - after.length)).fill("0"), ...after]
			: [...head, ...after];
	if (groups.length !== 8 || !groups.every((group) => HEXTET.test(group))) return null;
	return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * The rate-limit key for a client address. IPv4 as is; IPv6 as its /64; an
 * IPv6 spelling of an IPv4 host as that IPv4 address, so one host has one key
 * whichever way it is written: mapped (`::ffff:a.b.c.d`) and NAT64
 * (`64:ff9b::a.b.c.d`), dotted or in hex, and compatible (`::a.b.c.d`) DOTTED
 * only — in hex it is indistinguishable from an ordinary low address such as
 * `::1`, which keys as its /64. `null` only
 * when the header is absent or empty; any other value that does not parse is
 * keyed as written (trimmed, lower-cased, capped), so an odd spelling is still
 * limited rather than let through.
 */
export function clientNetwork(ip: string | null): string | null {
	const value = (ip ?? "").trim().toLowerCase();
	if (value === "") return null;
	if (isIpv4(value)) return value;
	const groups = value.includes(":") ? ipv6Groups(value) : null;
	if (groups === null) return `raw:${value.slice(0, RAW_KEY_MAX)}`;
	const hex = groups.map((group) => group.toString(16));
	const zeroFive = groups.slice(0, 5).every((group) => group === 0);
	const mapped = zeroFive && groups[5] === 0xffff;
	const compat = zeroFive && groups[5] === 0 && value.includes(".");
	const nat64 = hex.slice(0, 6).join(":") === NAT64.join(":");
	if (mapped || compat || nat64) {
		const high = groups[6] ?? 0;
		const low = groups[7] ?? 0;
		return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
	}
	return `${hex.slice(0, 4).join(":")}::/64`;
}

/** Cloudflare's Pseudo IPv4 range (240.0.0.0/4, class E). */
const PSEUDO_IPV4 = /^2(4\d|5[0-5])\./;

/**
 * The client's address as Cloudflare reports it: `CF-Connecting-IP`, unless
 * that is a Pseudo IPv4 address — the zone's "Pseudo IPv4: Overwrite headers"
 * mode puts one (240.0.0.0/4, a hash of the real address) there for an IPv6
 * client and the real address in `CF-Connecting-IPv6`; then the IPv6 address,
 * so the client is keyed by its /64 like any other. `CF-Connecting-IPv6` is
 * read ONLY in that case: a real IPv4 client cannot hold a 240/4 address, so a
 * header it sends itself can never pick its own key.
 */
export function clientAddress(headers: Headers): string | null {
	const ip = headers.get("cf-connecting-ip");
	if (ip !== null && PSEUDO_IPV4.test(ip.trim())) {
		const ipv6 = headers.get("cf-connecting-ipv6");
		if (ipv6 !== null && ipv6.trim() !== "") return ipv6;
	}
	return ip;
}

/** The binding's surface (`RateLimit` in @cloudflare/workers-types). */
interface RateLimiter {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

function limiterFrom(
	env: Record<string, unknown> | undefined,
	cls: RateLimitClass,
): RateLimiter | undefined {
	const candidate = env?.[RATE_LIMIT_BINDINGS[cls]];
	if (typeof candidate !== "object" || candidate === null) return undefined;
	return typeof (candidate as Record<string, unknown>)["limit"] === "function"
		? (candidate as RateLimiter)
		: undefined;
}

const loggedMissing = new Set<RateLimitClass>();
/** A failing binding is logged at most this often, so an ongoing outage stays
 *  visible in the logs without one line per request. */
export const FAILURE_LOG_INTERVAL_MS = 5 * 60 * 1000;
let lastFailureLog = Number.NEGATIVE_INFINITY;

/** Test hook: forget which lines were already logged. */
export function resetRateLimitLogForTests(): void {
	loggedMissing.clear();
	lastFailureLog = Number.NEGATIVE_INFINITY;
}

const MESSAGE = "Too many requests. Please wait a minute and try again.";

/** The 429: EmDash's JSON error envelope on the plugin mount (`backTo`
 *  null — what every other refusal there looks like), a small HTML page with a
 *  "Go back" link on a site form endpoint (what a browser can show). Never
 *  stored. */
export function rateLimitedResponse(cls: RateLimitClass, backTo: string | null): Response {
	const headers: Record<string, string> = {
		"Retry-After": String(RETRY_AFTER_SECONDS[cls]),
		"Cache-Control": PRIVATE_NO_STORE,
		"X-Content-Type-Options": "nosniff",
	};
	if (backTo === null) {
		return Response.json(
			{ success: false, error: { code: "RATE_LIMITED", message: MESSAGE } },
			{ status: 429, headers },
		);
	}
	const body =
		'<!doctype html><html lang="en"><head><meta charset="utf-8">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1">' +
		`<title>Too many requests</title></head><body><main><p>${MESSAGE}</p>` +
		`<p><a href="${backTo}">Go back</a></p></main></body></html>`;
	return new Response(body, {
		status: 429,
		headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
	});
}

/** Where a site route's 429 "Go back" points: a resume goes back to its order
 *  page (the shopper came from there), else the route's own `backTo`. */
function siteBackTo(routePattern: string, url: URL): string {
	if (routePattern === RESUME_ROUTE) {
		const order = resumeOrderParam(url);
		if (order !== "") return orderPathFor(order);
	}
	return SITE_ROUTES.get(routePattern)?.backTo ?? "/";
}

/** The middleware's whole check: the 429 for a request over its class's
 *  limit, or null when it may proceed (including every fail-open case). */
export async function enforceRateLimit(
	context: { request: Request; url: URL; routePattern: string },
	env: Record<string, unknown> | undefined,
): Promise<Response | null> {
	const { request, url, routePattern } = context;
	const cls = rateLimitClassFor(request.method, url, routePattern, request);
	if (cls === null) return null;
	const limiter = limiterFrom(env, cls);
	if (limiter === undefined) {
		if (!loggedMissing.has(cls)) {
			loggedMissing.add(cls);
			console.warn(
				`[site-staging] rate limiting is OFF for ${cls} routes: no ${RATE_LIMIT_BINDINGS[cls]} binding (DEPLOYMENT.md §2.5). Requests pass unlimited.`,
			);
		}
		return null;
	}
	const network = clientNetwork(clientAddress(request.headers));
	if (network === null) return null;
	try {
		const { success } = await limiter.limit({ key: `${cls}:${network}` });
		if (success) return null;
	} catch (error) {
		const now = Date.now();
		if (now - lastFailureLog >= FAILURE_LOG_INTERVAL_MS) {
			lastFailureLog = now;
			console.error("[site-staging] rate limit check failed; passing the request:", error);
		}
		return null;
	}
	return rateLimitedResponse(
		cls,
		pluginRouteOf(url) === null ? siteBackTo(routePattern, url) : null,
	);
}
