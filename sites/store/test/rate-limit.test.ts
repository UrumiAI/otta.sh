/**
 * Per-IP rate limiting on the anonymous write surface and the login requests
 * (issues #91, #29; `src/lib/rate-limit.ts`), as the middleware applies it.
 *
 * Pins:
 *  - which routes are limited, and in which class (auth or writes);
 *  - over the limit → 429 + Retry-After, in EmDash's JSON envelope on the
 *    plugin mount and as a small HTML page on the site's form endpoints, and
 *    the endpoint never runs;
 *  - under the limit → the endpoint runs;
 *  - the key is the class plus the client's IP (IPv6 by /64);
 *  - site GETs (but `/checkout/resume`'s) and every unprotected route are
 *    never counted;
 *  - FAIL OPEN: no binding, no client IP, or a binding that throws → the
 *    endpoint runs; a missing binding is logged once, a failing one at most
 *    once per interval.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(handler: T): T => handler,
}));

import {
	ACCOUNT_LOGIN_REQUEST_ROUTE,
	ACCOUNT_LOGIN_VERIFY_ROUTE,
	OTTA_PLUGIN_ID,
	STOREFRONT_CART_CREATE_ROUTE,
	STOREFRONT_CART_LINE_ADD_ROUTE,
	STOREFRONT_CART_LINE_REMOVE_ROUTE,
	STOREFRONT_CART_LINE_UPDATE_ROUTE,
	STOREFRONT_CART_READ_ROUTE,
	STOREFRONT_CHECKOUT_PLACE_ROUTE,
	STOREFRONT_ORDER_ABANDON_ROUTE,
	STOREFRONT_ORDER_RESUME_ROUTE,
	STOREFRONT_PRODUCT_ROUTE,
	plugin as ottaPlugin,
} from "@urumi.ai/otta-plugin";
import * as ottaPluginExports from "@urumi.ai/otta-plugin";
import {
	FAILURE_LOG_INTERVAL_MS,
	PLUGIN_ROUTES,
	RATE_LIMIT_BINDINGS,
	RATE_LIMIT_EXEMPT_PLUGIN_ROUTES,
	RATE_LIMIT_EXEMPT_SITE_ROUTES,
	RETRY_AFTER_SECONDS,
	SITE_ROUTES,
	clientAddress,
	clientNetwork,
	rateLimitedResponse,
	rateLimitClassFor as rateLimitClassForRequest,
	resetRateLimitLogForTests,
} from "../src/lib/rate-limit.js";
import { onRequest } from "../src/middleware.js";
import { env } from "./helpers/virtual-emdash-env.js";
import { SRC } from "./theme-views.js";

const SITE = "http://localhost:4321";
const IP = "203.0.113.7";

type Handler = (ctx: unknown, next: () => Promise<Response>) => Promise<Response>;
const runMiddleware = onRequest as unknown as Handler;

/** `rateLimitClassFor` with a plain request (no headers) unless one is given. */
const classFor = (
	method: string,
	url: URL,
	routePattern: string,
	request: Pick<Request, "headers"> = new Request(url),
) => rateLimitClassForRequest(method, url, routePattern, request);

const plugin = (route: string) => `/_emdash/api/plugins/${OTTA_PLUGIN_ID}/${route}`;

function context(
	method: string,
	pathname: string,
	routePattern: string,
	opts: { ip?: string | null } = {},
) {
	const url = new URL(pathname, SITE);
	const headers: Record<string, string> = {};
	const ip = opts.ip === undefined ? IP : opts.ip;
	if (ip !== null) headers["cf-connecting-ip"] = ip;
	return {
		request: new Request(url, { method, headers }),
		url,
		routePattern,
		cookies: { get: () => undefined, set: vi.fn(), delete: vi.fn() },
		locals: {},
		cache: { set: vi.fn() },
	};
}

function endpoint() {
	return vi.fn(() => Promise.resolve(new Response("endpoint ran", { status: 299 })));
}

/** A binding stand-in: answers `success` and records every key it was asked. */
function binding(success: boolean | (() => Promise<{ success: boolean }>)) {
	return {
		limit: vi.fn((_options: { key: string }) =>
			typeof success === "function" ? success() : Promise.resolve({ success }),
		),
	};
}

const PLUGIN_MOUNT_PATTERN = "/_emdash/api/plugins/[pluginId]/[...path]";

beforeEach(() => {
	resetRateLimitLogForTests();
});

afterEach(() => {
	delete env[RATE_LIMIT_BINDINGS.auth];
	delete env[RATE_LIMIT_BINDINGS.writes];
	vi.restoreAllMocks();
});

describe("the protected route table", () => {
	const AUTH_SITE = ["/account/login/request", "/account/verify/confirm", "/checkout/resume"];
	const WRITES_SITE = [
		"/cart/add",
		"/cart/update",
		"/cart/remove",
		"/cart/switch-currency",
		"/checkout/place",
		"/checkout/new-cart",
	];
	const AUTH_PLUGIN = [
		ACCOUNT_LOGIN_REQUEST_ROUTE,
		ACCOUNT_LOGIN_VERIFY_ROUTE,
		STOREFRONT_ORDER_RESUME_ROUTE,
	];
	const WRITES_PLUGIN = [
		STOREFRONT_CART_CREATE_ROUTE,
		STOREFRONT_CART_LINE_ADD_ROUTE,
		STOREFRONT_CART_LINE_UPDATE_ROUTE,
		STOREFRONT_CART_LINE_REMOVE_ROUTE,
		STOREFRONT_CHECKOUT_PLACE_ROUTE,
		STOREFRONT_ORDER_ABANDON_ROUTE,
	];

	test.each(AUTH_SITE)("site POST %s is auth", (route) => {
		expect(classFor("POST", new URL(route, SITE), route)).toBe("auth");
	});
	test.each(WRITES_SITE)("site POST %s is writes", (route) => {
		expect(classFor("POST", new URL(route, SITE), route)).toBe("writes");
	});
	test.each(AUTH_PLUGIN)("plugin %s is auth", (route) => {
		expect(classFor("POST", new URL(plugin(route), SITE), PLUGIN_MOUNT_PATTERN)).toBe("auth");
	});
	test.each(WRITES_PLUGIN)("plugin %s is writes", (route) => {
		expect(classFor("POST", new URL(plugin(route), SITE), PLUGIN_MOUNT_PATTERN)).toBe("writes");
	});

	test("site GETs are never counted, even on a protected route — except /checkout/resume", () => {
		for (const route of [...AUTH_SITE, ...WRITES_SITE]) {
			if (route === "/checkout/resume") continue;
			expect(classFor("GET", new URL(route, SITE), route)).toBeNull();
			expect(classFor("HEAD", new URL(route, SITE), route)).toBeNull();
		}
	});

	test("GET /checkout/resume counts (it dispatches the plugin's resume step), OPTIONS does not", () => {
		const url = new URL("/checkout/resume?order=x", SITE);
		expect(classFor("GET", url, "/checkout/resume")).toBe("auth");
		expect(classFor("HEAD", url, "/checkout/resume")).toBe("auth");
		expect(classFor("OPTIONS", url, "/checkout/resume")).toBeNull();
	});

	test("GET/HEAD /checkout/resume that the handler answers without the plugin is NOT counted (#661)", () => {
		const withOrder = new URL("/checkout/resume?order=x", SITE);
		const crossSite = new Request(withOrder, { headers: { "sec-fetch-site": "cross-site" } });
		const sameSite = new Request(withOrder, { headers: { "sec-fetch-site": "same-origin" } });
		for (const method of ["GET", "HEAD"]) {
			// A third-party <img> must not burn the visitor's auth budget.
			expect(classFor(method, withOrder, "/checkout/resume", crossSite)).toBeNull();
			// Same-site with an order still counts.
			expect(classFor(method, withOrder, "/checkout/resume", sameSite)).toBe("auth");
			// No order, or an empty/blank one: the handler redirects to the cart.
			for (const search of ["", "?order=", "?order=%20%20"]) {
				const url = new URL(`/checkout/resume${search}`, SITE);
				expect(classFor(method, url, "/checkout/resume", new Request(url))).toBeNull();
			}
		}
		// The POST (email form) is never exempted by these rules.
		expect(classFor("POST", withOrder, "/checkout/resume", crossSite)).toBe("auth");
		const bare = new URL("/checkout/resume", SITE);
		expect(classFor("POST", bare, "/checkout/resume", new Request(bare))).toBe("auth");
	});

	test("a cross-site GET /checkout/resume reaches the endpoint without spending the budget (#661)", async () => {
		const auth = binding(false);
		env[RATE_LIMIT_BINDINGS.auth] = auth;
		const ctx = context("GET", "/checkout/resume?order=x", "/checkout/resume");
		ctx.request = new Request(ctx.url, {
			headers: { "sec-fetch-site": "cross-site", "cf-connecting-ip": IP },
		});
		const next = endpoint();
		const response = await runMiddleware(ctx, next);
		expect(response.status).toBe(299);
		expect(auth.limit).not.toHaveBeenCalled();
	});

	test("a plugin write route counts on ANY method but OPTIONS (EmDash dispatches GET with query input)", () => {
		const url = new URL(plugin(STOREFRONT_CART_CREATE_ROUTE), SITE);
		for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
			expect(classFor(method, url, PLUGIN_MOUNT_PATTERN)).toBe("writes");
		}
		expect(classFor("OPTIONS", url, PLUGIN_MOUNT_PATTERN)).toBeNull();
	});

	test("plugin path spellings that still reach the route are matched", () => {
		const spellings = [
			`/_emdash/api/plugins/${OTTA_PLUGIN_ID}//storefront/cart/create`,
			`/_emdash/api/plugins/${OTTA_PLUGIN_ID}/storefront/cart/create/`,
			`/_emdash/api/plugins/${OTTA_PLUGIN_ID}/storefront/%63art/create`,
		];
		for (const spelling of spellings) {
			expect(classFor("POST", new URL(spelling, SITE), PLUGIN_MOUNT_PATTERN)).toBe("writes");
		}
	});

	test("unprotected routes are never counted", () => {
		const reads = [STOREFRONT_PRODUCT_ROUTE, STOREFRONT_CART_READ_ROUTE, "admin"];
		for (const route of reads) {
			expect(classFor("POST", new URL(plugin(route), SITE), PLUGIN_MOUNT_PATTERN)).toBeNull();
		}
		expect(
			classFor(
				"POST",
				new URL(`/_emdash/api/plugins/other/${STOREFRONT_CART_CREATE_ROUTE}`, SITE),
				PLUGIN_MOUNT_PATTERN,
			),
		).toBeNull();
		for (const route of [
			"/account/logout",
			"/webhooks/stripe",
			"/otta-admin/downloads/[productId]",
		]) {
			expect(classFor("POST", new URL(route, SITE), route)).toBeNull();
		}
	});
});

// ── default-deny coverage ─────────────────────────────────────────────────

const ENDPOINT_FILE = /\.(ts|mts|js|mjs)$/;
const PAGE_FILE = /\.(ts|mts|js|mjs|astro)$/;

/** Does this endpoint source export a handler for a non-GET method? (The
 *  origin-middleware suite pins this detector's cases.) */
function exportsWriteHandler(source: string): boolean {
	const method = String.raw`(POST|PUT|PATCH|DELETE|ALL)`;
	const declared = new RegExp(
		String.raw`export\s+(const|let|var|(async\s+)?function\*?)\s+${method}\b`,
	);
	const reexported = new RegExp(String.raw`export\s*\{[^}]*\b${method}\b[^}]*\}`);
	return declared.test(source) || reexported.test(source);
}

/** Does this page answer GET? An `.astro` page always does; an endpoint when
 *  it exports GET or ALL. */
function answersGet(page: PageFile): boolean {
	if (page.file.endsWith(".astro")) return true;
	const method = String.raw`(GET|ALL)`;
	const declared = new RegExp(
		String.raw`export\s+(const|let|var|(async\s+)?function\*?)\s+${method}\b`,
	);
	const reexported = new RegExp(String.raw`export\s*\{[^}]*\b${method}\b[^}]*\}`);
	return declared.test(page.source) || reexported.test(page.source);
}

interface PageFile {
	route: string;
	file: string;
	source: string;
}

/** Every file under a pages dir with its route pattern, matching `filter`. */
function pageFiles(pages: string, filter: RegExp): PageFile[] {
	const found: PageFile[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!filter.test(entry.name)) continue;
			const route = `/${path.relative(pages, full)}`.replace(PAGE_FILE, "").replace(/\/index$/, "");
			found.push({
				route: route === "" ? "/" : route,
				file: entry.name,
				source: readFileSync(full, "utf8"),
			});
		}
	};
	walk(pages);
	return found;
}

/** The route patterns under src/pages that export a write handler. */
function siteWriteRoutes(pages = path.join(SRC, "pages")): string[] {
	return pageFiles(pages, ENDPOINT_FILE)
		.filter(({ source }) => exportsWriteHandler(source))
		.map(({ route }) => route)
		.toSorted();
}

/** The exported names of the plugin route constants that are PLUGIN_ROUTES keys. */
function limitedPluginRouteConstants(): string[] {
	return Object.entries(ottaPluginExports)
		.filter(([name, value]) => name.endsWith("_ROUTE") && PLUGIN_ROUTES.has(String(value)))
		.map(([name]) => name);
}

/**
 * Lib helpers that dispatch a limited plugin route on a page's behalf, so a
 * page calling one is a reference too. An EXPLICIT list, guarded below: the
 * scan cannot follow calls in general, so a new lib file that references a
 * limited constant must be added to LIB_DISPATCHERS (and its helper here) or
 * the guard test fails. Limitation: only direct references by name are seen.
 */
const LIMITED_ROUTE_HELPERS = ["ensureCartId"];
/** The lib files that reference a limited constant (the dispatch table, the
 *  helper above, and the limiter's own table). */
const LIB_DISPATCHERS = ["cart-actions.ts", "otta-api.ts", "rate-limit.ts"];

/** Violations of the page-level default-deny, as readable lines: every page
 *  (`.ts` or `.astro`) that references a limited plugin route constant is in
 *  SITE_ROUTES or exempt, and `anyMethod` when it answers GET. */
function pageCoverageViolations(pages = path.join(SRC, "pages")): string[] {
	const names = [...limitedPluginRouteConstants(), ...LIMITED_ROUTE_HELPERS];
	const reference = new RegExp(String.raw`\b(${names.join("|")})\b`);
	const problems: string[] = [];
	for (const page of pageFiles(pages, PAGE_FILE)) {
		if (!reference.test(page.source)) continue;
		const site = SITE_ROUTES.get(page.route);
		if (site === undefined && !RATE_LIMIT_EXEMPT_SITE_ROUTES.has(page.route)) {
			problems.push(`${page.route}: dispatches a limited plugin route; in neither map`);
		} else if (site !== undefined && answersGet(page) && site.anyMethod !== true) {
			problems.push(`${page.route}: answers GET but is not anyMethod`);
		}
	}
	return problems;
}

describe("every write route is limited or explicitly exempt (default-deny)", () => {
	test("each site write endpoint is in SITE_ROUTES or the exemption map — never neither, never both", () => {
		const routes = siteWriteRoutes();
		expect(routes.length).toBeGreaterThan(0);
		for (const route of routes) {
			const limited = SITE_ROUTES.has(route);
			const exempt = RATE_LIMIT_EXEMPT_SITE_ROUTES.has(route);
			expect(limited !== exempt, route).toBe(true);
		}
		// No stale entries either.
		for (const route of [...SITE_ROUTES.keys(), ...RATE_LIMIT_EXEMPT_SITE_ROUTES.keys()]) {
			expect(routes, route).toContain(route);
		}
	});

	test("each page (.ts or .astro) dispatching a limited plugin route is limited or exempt, anyMethod if it answers GET (#661)", () => {
		expect(limitedPluginRouteConstants().length).toBe(PLUGIN_ROUTES.size);
		expect(pageCoverageViolations()).toEqual([]);
	});

	test("lib helpers that dispatch a limited route are listed (guard for the page scan)", () => {
		const lib = path.join(SRC, "lib");
		const names = limitedPluginRouteConstants();
		const reference = new RegExp(String.raw`\b(${names.join("|")})\b`);
		const referencing = readdirSync(lib)
			.filter(
				(file) =>
					ENDPOINT_FILE.test(file) && reference.test(readFileSync(path.join(lib, file), "utf8")),
			)
			.toSorted();
		expect(referencing).toEqual(LIB_DISPATCHERS);
		const cartActions = readFileSync(path.join(lib, "cart-actions.ts"), "utf8");
		for (const helper of LIMITED_ROUTE_HELPERS) {
			expect(cartActions).toMatch(
				new RegExp(String.raw`export\s+(async\s+)?function\s+${helper}\b`),
			);
		}
	});

	test("the page scan flags a GET on a non-anyMethod route and a page using a dispatching helper (#661)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "rl-pages-"));
		try {
			mkdirSync(path.join(dir, "cart"));
			writeFileSync(
				path.join(dir, "cart", "add.ts"),
				"import { STOREFRONT_CART_LINE_ADD_ROUTE } from '@urumi.ai/otta-plugin';\nexport const GET = () => STOREFRONT_CART_LINE_ADD_ROUTE;\nexport const POST = GET;\n",
			);
			writeFileSync(
				path.join(dir, "mint.ts"),
				"import { ensureCartId } from '../lib/cart-actions.js';\nexport const POST = (c) => ensureCartId(c, undefined);\n",
			);
			expect(pageCoverageViolations(dir).toSorted()).toEqual([
				"/cart/add: answers GET but is not anyMethod",
				"/mint: dispatches a limited plugin route; in neither map",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the page scan catches a GET endpoint and an .astro page that dispatch a limited route (#661)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "rl-pages-"));
		try {
			mkdirSync(path.join(dir, "cart"));
			writeFileSync(
				path.join(dir, "cart", "quick-add.ts"),
				"import { STOREFRONT_CART_LINE_ADD_ROUTE } from '@urumi.ai/otta-plugin';\nexport const GET = () => STOREFRONT_CART_LINE_ADD_ROUTE;\n",
			);
			writeFileSync(
				path.join(dir, "go.astro"),
				"---\nimport { STOREFRONT_CART_CREATE_ROUTE } from '@urumi.ai/otta-plugin';\n---\n<p>{STOREFRONT_CART_CREATE_ROUTE}</p>\n",
			);
			expect(pageCoverageViolations(dir).toSorted()).toEqual([
				"/cart/quick-add: dispatches a limited plugin route; in neither map",
				"/go: dispatches a limited plugin route; in neither map",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("/checkout/resume is limited on GET too (its GET dispatches the plugin's resume step)", () => {
		expect(SITE_ROUTES.get("/checkout/resume")?.anyMethod).toBe(true);
	});

	test("each PUBLIC plugin route is in PLUGIN_ROUTES or the exemption map — never neither, never both", () => {
		const routes = Object.entries(ottaPlugin.routes ?? {})
			.filter(([, route]) => (route as { public?: boolean }).public === true)
			.map(([name]) => name);
		expect(routes.length).toBeGreaterThan(0);
		for (const route of routes) {
			const limited = PLUGIN_ROUTES.has(route);
			const exempt = RATE_LIMIT_EXEMPT_PLUGIN_ROUTES.has(route);
			expect(limited !== exempt, route).toBe(true);
		}
		for (const route of [...PLUGIN_ROUTES.keys(), ...RATE_LIMIT_EXEMPT_PLUGIN_ROUTES.keys()]) {
			expect(routes, route).toContain(route);
		}
	});

	test("every exemption carries a reason", () => {
		for (const reason of [
			...RATE_LIMIT_EXEMPT_SITE_ROUTES.values(),
			...RATE_LIMIT_EXEMPT_PLUGIN_ROUTES.values(),
		]) {
			expect(reason.trim().length).toBeGreaterThan(10);
		}
	});
});

// ── the configured limits: template, runbook and Retry-After agree ─────────

/** `{ name, limit, period }` for each rate-limit binding line in a file (the
 *  template's commented example or the runbook's code block). */
function bindingLines(file: string): Map<string, { limit: number; period: number }> {
	const found = new Map<string, { limit: number; period: number }>();
	const line =
		/"name":\s*"(RATE_LIMIT_\w+)",\s*"namespace_id":\s*"\d+",\s*"simple":\s*\{\s*"limit":\s*(\d+),\s*"period":\s*(\d+)/g;
	for (const match of readFileSync(file, "utf8").matchAll(line)) {
		found.set(match[1] ?? "", { limit: Number(match[2]), period: Number(match[3]) });
	}
	return found;
}

describe("the configured limits", () => {
	const template = bindingLines(path.join(SRC, "..", "wrangler.jsonc"));
	const runbook = bindingLines(path.join(SRC, "..", "..", "..", "DEPLOYMENT.md"));

	test("the template and DEPLOYMENT.md give both bindings, with the same numbers", () => {
		expect([...template.keys()].toSorted()).toEqual(Object.values(RATE_LIMIT_BINDINGS).toSorted());
		expect(runbook).toEqual(template);
	});

	test("auth is the tighter class", () => {
		const auth = template.get(RATE_LIMIT_BINDINGS.auth);
		const writes = template.get(RATE_LIMIT_BINDINGS.writes);
		expect(auth?.limit).toBeLessThan(writes?.limit ?? 0);
	});

	test("each period is one the binding accepts, and is the Retry-After the site sends", () => {
		for (const cls of ["auth", "writes"] as const) {
			const period = template.get(RATE_LIMIT_BINDINGS[cls])?.period;
			expect([10, 60]).toContain(period);
			expect(RETRY_AFTER_SECONDS[cls]).toBe(period);
		}
	});
});

describe("clientNetwork", () => {
	test("IPv4 is the address itself", () => {
		expect(clientNetwork("203.0.113.7")).toBe("203.0.113.7");
	});
	test("IPv6 is its /64, however it is spelled", () => {
		expect(clientNetwork("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
		expect(clientNetwork("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
		expect(clientNetwork("2001:db8::1")).toBe("2001:db8:0:0::/64");
	});
	test("IPv4-mapped IPv6 is the IPv4 address", () => {
		expect(clientNetwork("::ffff:198.51.100.4")).toBe("198.51.100.4");
	});
	test("every IPv6 spelling of an IPv4 host is that IPv4 address", () => {
		for (const spelling of [
			"::ffff:198.51.100.4",
			"::FFFF:198.51.100.4",
			"0:0:0:0:0:ffff:198.51.100.4",
			"::ffff:c633:6404",
			"::198.51.100.4",
			"64:ff9b::198.51.100.4",
			"64:ff9b::c633:6404",
		]) {
			expect(clientNetwork(spelling), spelling).toBe("198.51.100.4");
		}
	});
	test("an embedded IPv4 tail on an ordinary prefix is still keyed by its /64", () => {
		expect(clientNetwork("2001:db8:1:2::198.51.100.4")).toBe("2001:db8:1:2::/64");
	});
	test("absent → null (fail open); present but unparseable → keyed as written", () => {
		expect(clientNetwork(null)).toBeNull();
		expect(clientNetwork("")).toBeNull();
		expect(clientNetwork("  ")).toBeNull();
		expect(clientNetwork("Not An IP")).toBe("raw:not an ip");
		expect(clientNetwork("1:2:3")).toBe("raw:1:2:3");
		expect(clientNetwork("::ffff:300.1.1.1")).toBe("raw:::ffff:300.1.1.1");
		expect(clientNetwork("999.1.1.1")).toBe("raw:999.1.1.1");
		expect(clientNetwork("x".repeat(200))).toBe(`raw:${"x".repeat(64)}`);
	});
});

const headers = (values: Record<string, string>) => new Headers(values);

describe("clientAddress", () => {
	test("CF-Connecting-IP when it is a real address", () => {
		expect(clientAddress(headers({ "cf-connecting-ip": IP }))).toBe(IP);
	});
	test("a Pseudo IPv4 (240.0.0.0/4) defers to CF-Connecting-IPv6", () => {
		const ipv6 = "2001:db8:1:2::9";
		expect(
			clientAddress(headers({ "cf-connecting-ip": "240.12.34.56", "cf-connecting-ipv6": ipv6 })),
		).toBe(ipv6);
		expect(
			clientAddress(headers({ "cf-connecting-ip": "255.1.2.3", "cf-connecting-ipv6": ipv6 })),
		).toBe(ipv6);
	});
	test("CF-Connecting-IPv6 is ignored beside a real IPv4 address (a client cannot pick its key)", () => {
		expect(
			clientAddress(headers({ "cf-connecting-ip": IP, "cf-connecting-ipv6": "2001:db8::1" })),
		).toBe(IP);
	});
	test("a Pseudo IPv4 with no IPv6 header is keyed as itself", () => {
		expect(clientAddress(headers({ "cf-connecting-ip": "240.12.34.56" }))).toBe("240.12.34.56");
	});
	test("no header → null", () => {
		expect(clientAddress(headers({}))).toBeNull();
	});
});

describe("the middleware", () => {
	test("over the limit on a plugin route → 429 JSON envelope + Retry-After; endpoint never runs", async () => {
		const writes = binding(false);
		env[RATE_LIMIT_BINDINGS.writes] = writes;
		const next = endpoint();
		const response = await runMiddleware(
			context("POST", plugin(STOREFRONT_CART_CREATE_ROUTE), PLUGIN_MOUNT_PATTERN),
			next,
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe(String(RETRY_AFTER_SECONDS.writes));
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		expect(response.headers.get("Content-Type")).toContain("application/json");
		const body = (await response.json()) as { success: boolean; error: { code: string } };
		expect(body.success).toBe(false);
		expect(body.error.code).toBe("RATE_LIMITED");
		expect(next).not.toHaveBeenCalled();
		expect(writes.limit).toHaveBeenCalledWith({ key: `writes:${IP}` });
	});

	test("over the limit on a site form endpoint → 429 HTML page + Retry-After", async () => {
		env[RATE_LIMIT_BINDINGS.auth] = binding(false);
		const next = endpoint();
		const response = await runMiddleware(
			context("POST", "/account/login/request", "/account/login/request"),
			next,
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe(String(RETRY_AFTER_SECONDS.auth));
		expect(response.headers.get("Content-Type")).toContain("text/html");
		const html = await response.text();
		expect(html).toContain("Too many requests");
		expect(html).toContain('href="/account/login"');
		expect(next).not.toHaveBeenCalled();
	});

	test("each class asks its own binding with its own key", async () => {
		const auth = binding(true);
		const writes = binding(true);
		env[RATE_LIMIT_BINDINGS.auth] = auth;
		env[RATE_LIMIT_BINDINGS.writes] = writes;
		await runMiddleware(
			context("POST", plugin(ACCOUNT_LOGIN_REQUEST_ROUTE), PLUGIN_MOUNT_PATTERN),
			endpoint(),
		);
		expect(auth.limit).toHaveBeenCalledWith({ key: `auth:${IP}` });
		expect(writes.limit).not.toHaveBeenCalled();
	});

	test("in Pseudo IPv4 mode the key is the client's IPv6 /64", async () => {
		const writes = binding(true);
		env[RATE_LIMIT_BINDINGS.writes] = writes;
		const ctx = context("POST", "/cart/add", "/cart/add");
		ctx.request = new Request(ctx.url, {
			method: "POST",
			headers: { "cf-connecting-ip": "240.12.34.56", "cf-connecting-ipv6": "2001:db8:1:2::9" },
		});
		await runMiddleware(ctx, endpoint());
		expect(writes.limit).toHaveBeenCalledWith({ key: "writes:2001:db8:1:2::/64" });
	});

	test("under the limit → the endpoint runs", async () => {
		env[RATE_LIMIT_BINDINGS.writes] = binding(true);
		const next = endpoint();
		const response = await runMiddleware(context("POST", "/cart/add", "/cart/add"), next);
		expect(response.status).toBe(299);
		expect(next).toHaveBeenCalledOnce();
	});

	test("a site GET is never counted", async () => {
		const auth = binding(false);
		env[RATE_LIMIT_BINDINGS.auth] = auth;
		const next = endpoint();
		const response = await runMiddleware(
			context("GET", "/account/login/request", "/account/login/request"),
			next,
		);
		expect(response.status).toBe(299);
		expect(auth.limit).not.toHaveBeenCalled();
	});

	test("an unprotected write is never counted", async () => {
		const writes = binding(false);
		const auth = binding(false);
		env[RATE_LIMIT_BINDINGS.writes] = writes;
		env[RATE_LIMIT_BINDINGS.auth] = auth;
		const next = endpoint();
		const response = await runMiddleware(
			context("POST", plugin(STOREFRONT_CART_READ_ROUTE), PLUGIN_MOUNT_PATTERN),
			next,
		);
		expect(response.status).toBe(299);
		expect(writes.limit).not.toHaveBeenCalled();
		expect(auth.limit).not.toHaveBeenCalled();
	});

	test("binding absent → FAIL OPEN, logged once per class", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (let i = 0; i < 3; i++) {
			const next = endpoint();
			const response = await runMiddleware(context("POST", "/cart/add", "/cart/add"), next);
			expect(response.status).toBe(299);
		}
		expect(warn).toHaveBeenCalledOnce();
		expect(String(warn.mock.calls[0]?.[0])).toContain(RATE_LIMIT_BINDINGS.writes);
	});

	test("no client IP → FAIL OPEN, the binding is not asked", async () => {
		const writes = binding(false);
		env[RATE_LIMIT_BINDINGS.writes] = writes;
		const next = endpoint();
		const response = await runMiddleware(
			context("POST", "/cart/add", "/cart/add", { ip: null }),
			next,
		);
		expect(response.status).toBe(299);
		expect(writes.limit).not.toHaveBeenCalled();
	});

	test("a binding that throws → FAIL OPEN", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		env[RATE_LIMIT_BINDINGS.writes] = binding(() => Promise.reject(new Error("boom")));
		const next = endpoint();
		const response = await runMiddleware(context("POST", "/cart/add", "/cart/add"), next);
		expect(response.status).toBe(299);
	});

	test("a failing binding is logged at most once per interval, and again after it", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		env[RATE_LIMIT_BINDINGS.writes] = binding(() => Promise.reject(new Error("boom")));
		const post = () => runMiddleware(context("POST", "/cart/add", "/cart/add"), endpoint());
		await post();
		await post();
		expect(error).toHaveBeenCalledOnce();
		now.mockReturnValue(1_000_000 + FAILURE_LOG_INTERVAL_MS - 1);
		await post();
		expect(error).toHaveBeenCalledOnce();
		now.mockReturnValue(1_000_000 + FAILURE_LOG_INTERVAL_MS);
		await post();
		expect(error).toHaveBeenCalledTimes(2);
	});

	test("over the limit on /checkout/resume (GET) → 429 whose Go back points at the order page", async () => {
		env[RATE_LIMIT_BINDINGS.auth] = binding(false);
		const next = endpoint();
		const response = await runMiddleware(
			context("GET", "/checkout/resume?order=x", "/checkout/resume"),
			next,
		);
		expect(response.status).toBe(429);
		expect(await response.text()).toContain('href="/orders/x"');
		expect(next).not.toHaveBeenCalled();
	});

	test("the resume 429 sends the shopper back to the order page; /cart without a valid order (#661)", async () => {
		env[RATE_LIMIT_BINDINGS.auth] = binding(false);
		const back = async (target: string): Promise<string> =>
			(await runMiddleware(context("GET", target, "/checkout/resume"), endpoint())).text();
		expect(await back("/checkout/resume?order=ord%2F1")).toContain('href="/orders/ord%2F1"');
		// A POST carries the order in its form body, not the query: the cart.
		const post = await runMiddleware(
			context("POST", "/checkout/resume", "/checkout/resume"),
			endpoint(),
		);
		expect(post.status).toBe(429);
		expect(await post.text()).toContain('href="/cart"');
	});

	test("rateLimitedResponse escapes backTo in the href", async () => {
		const html = await rateLimitedResponse("auth", '/x"><script>&').text();
		expect(html).toContain('href="/x&quot;&gt;&lt;script&gt;&amp;"');
		expect(html).not.toContain("<script>");
	});

	test("a cross-origin write is refused by the origin guard before it spends budget", async () => {
		const writes = binding(true);
		env[RATE_LIMIT_BINDINGS.writes] = writes;
		const ctx = context("POST", "/cart/add", "/cart/add");
		ctx.request = new Request(ctx.url, {
			method: "POST",
			headers: { origin: "https://evil.example", "cf-connecting-ip": IP },
		});
		const response = await runMiddleware(ctx, endpoint());
		expect(response.status).toBe(403);
		expect(writes.limit).not.toHaveBeenCalled();
	});
});
