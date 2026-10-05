/**
 * The origin check runs ONCE, in `src/middleware.ts`, for every state-changing
 * storefront route (issue #376 part 3; ADR-0006's CSRF section).
 *
 * It used to be a `rejectCrossOrigin(context)` call each endpoint made first.
 * This suite pins:
 *  - a TABLE over every non-GET route under `src/pages`, discovered from the
 *    source, saying guarded or exempt — a new write route that is in neither
 *    column fails here, so the choice is always explicit;
 *  - every cross-origin refusal is ONE answer (status, body, every header) —
 *    the strictest any endpoint used to send — and the endpoint never runs;
 *  - same-origin and Origin-less requests pass straight through, as before;
 *  - the Stripe webhook is never refused, whatever Origin a proxy adds;
 *  - GET/HEAD/OPTIONS and everything under `/_` (EmDash's admin and API, which
 *    guard themselves) are untouched;
 *  - no endpoint carries its own copy of the check any more.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(handler: T): T => handler,
}));

import { PRIVATE_NO_STORE } from "../src/lib/no-store.js";
import {
	CROSS_ORIGIN_REFUSAL_BODY,
	ORIGIN_GUARD_EXEMPT_ROUTES,
	originGuardApplies,
} from "../src/lib/origin-guard.js";
import { onRequest } from "../src/middleware.js";
import { SRC } from "./theme-views.js";

const SITE = "http://localhost:4321";
const EVIL = "https://evil.example";

type Handler = (ctx: unknown, next: () => Promise<Response>) => Promise<Response>;
const runMiddleware = onRequest as unknown as Handler;

/** A request as Astro hands it to the middleware. `routePattern` is the route
 *  Astro matched — always given explicitly, never derived from the path, since
 *  the path may be a trailing-slash or percent-encoded spelling of it. */
function context(
	method: string,
	pathname: string,
	routePattern: string,
	opts: { origin?: string | null; cookies?: Record<string, string> } = {},
) {
	const url = new URL(pathname, SITE);
	const headers: Record<string, string> = {};
	if (opts.origin !== undefined && opts.origin !== null) headers["origin"] = opts.origin;
	const jar = opts.cookies ?? {};
	return {
		request: new Request(url, { method, headers }),
		url,
		routePattern,
		cookies: {
			get: (name: string) => (name in jar ? { value: jar[name] } : undefined),
			set: vi.fn(),
			delete: vi.fn(),
		},
		locals: {},
		cache: { set: vi.fn() },
	};
}

/** `next()` standing in for the endpoint: records that it ran. */
function endpoint() {
	const next = vi.fn(() => Promise.resolve(new Response("endpoint ran", { status: 299 })));
	return next;
}

/** Every response header, lower-cased and sorted. */
function headerList(response: Response): Array<[string, string]> {
	return [...response.headers.entries()].toSorted(([a], [b]) => a.localeCompare(b));
}

// ── the route table ────────────────────────────────────────────────────────

/** The one refusal's headers, for every route: the body's type, plus the
 *  strictest pair any endpoint used to wrap its own refusal in. */
const REFUSAL_HEADERS: Array<[string, string]> = [
	["cache-control", PRIVATE_NO_STORE],
	["content-type", "text/plain;charset=UTF-8"],
	["referrer-policy", "no-referrer"],
];

/** Every non-GET route the site serves that the middleware guards (each a
 *  static route, so its pattern is its path). */
const GUARDED: readonly string[] = [
	"/account/login/request",
	"/account/logout",
	"/account/verify/confirm",
	"/cart/add",
	"/cart/remove",
	"/cart/update",
	"/checkout/new-cart",
	"/checkout/place",
	"/checkout/resume",
];
const EXEMPT: readonly string[] = ["/webhooks/stripe"];

/** Endpoint files Astro serves from `src/pages`. */
const ENDPOINT_FILE = /\.(ts|mts|js|mjs)$/;

/** Does this endpoint source export a handler for a non-GET method? Catches a
 *  declaration (`export const POST`, `export async function DELETE`), `ALL`,
 *  and a re-export (`export { handler as POST }`, `export { PUT } from "…"`). */
function exportsWriteHandler(source: string): boolean {
	const method = String.raw`(POST|PUT|PATCH|DELETE|ALL)`;
	const declared = new RegExp(
		String.raw`export\s+(const|let|var|(async\s+)?function\*?)\s+${method}\b`,
	);
	const reexported = new RegExp(String.raw`export\s*\{[^}]*\b${method}\b[^}]*\}`);
	return declared.test(source) || reexported.test(source);
}

/** The routes under src/pages that export a non-GET handler, read from source. */
function writeRoutes(): string[] {
	const pages = path.join(SRC, "pages");
	const routes: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!ENDPOINT_FILE.test(entry.name)) continue;
			if (!exportsWriteHandler(readFileSync(full, "utf8"))) continue;
			const route = `/${path.relative(pages, full)}`
				.replace(ENDPOINT_FILE, "")
				.replace(/\/index$/, "");
			routes.push(route === "" ? "/" : route);
		}
	};
	walk(pages);
	return routes.toSorted();
}

describe("the route table covers every write route the site serves", () => {
	test("each non-GET route is listed as guarded or exempt — never neither, never both", () => {
		expect(writeRoutes()).toEqual([...GUARDED, ...EXEMPT].toSorted());
		for (const route of EXEMPT) expect(GUARDED).not.toContain(route);
	});

	test.each([
		["export const POST: APIRoute = async () => r;", true],
		["export async function DELETE(context) {}", true],
		["export function PATCH() {}", true],
		["export const ALL: APIRoute = () => r;", true],
		["export let PUT = () => r;", true],
		["export { handler as POST };", true],
		["export { GET, POST } from './shared.js';", true],
		["export {\n\tupdate as PUT,\n};", true],
		["export const GET: APIRoute = () => r;", false],
		["export { handler as GET };", false],
		["const POST = 1; // not exported", false],
		["export const POSTAGE = 1;", false],
	])("the detector reads %j as a write handler: %s", (source, expected) => {
		expect(exportsWriteHandler(source)).toBe(expected);
	});

	test("the exemption list in the code is exactly the table's", () => {
		expect([...ORIGIN_GUARD_EXEMPT_ROUTES.keys()].toSorted()).toEqual([...EXEMPT].toSorted());
	});
});

describe("a guarded route refuses a cross-origin write before its endpoint runs", () => {
	test.each(GUARDED)(
		"cross-origin POST %s → the one 403, and the endpoint never runs",
		async (route) => {
			const next = endpoint();
			const response = await runMiddleware(context("POST", route, route, { origin: EVIL }), next);
			expect(response.status).toBe(403);
			expect(await response.text()).toBe(CROSS_ORIGIN_REFUSAL_BODY);
			expect(headerList(response)).toEqual(REFUSAL_HEADERS);
			expect(next).not.toHaveBeenCalled();
		},
	);

	test.each(GUARDED)("Origin: null (an opaque origin) on %s is refused", async (route) => {
		const next = endpoint();
		const response = await runMiddleware(context("POST", route, route, { origin: "null" }), next);
		expect(response.status).toBe(403);
		expect(next).not.toHaveBeenCalled();
	});

	test.each(GUARDED)("a same-origin POST %s reaches the endpoint untouched", async (route) => {
		const next = endpoint();
		const response = await runMiddleware(context("POST", route, route, { origin: SITE }), next);
		expect(response.status).toBe(299);
		expect(next).toHaveBeenCalledOnce();
	});

	test.each(GUARDED)(
		"a POST %s with NO Origin reaches the endpoint (curl / server-to-server, as before)",
		async (route) => {
			const next = endpoint();
			const response = await runMiddleware(context("POST", route, route, { origin: null }), next);
			expect(response.status).toBe(299);
			expect(next).toHaveBeenCalledOnce();
		},
	);

	test("a trailing slash or an encoded letter is the same route, and still refused", async () => {
		for (const [pathname, routePattern] of [
			["/checkout/place/", "/checkout/place"],
			["/checkout/pl%61ce", "/checkout/place"],
		] as const) {
			const next = endpoint();
			const response = await runMiddleware(
				context("POST", pathname, routePattern, { origin: EVIL }),
				next,
			);
			expect(response.status).toBe(403);
			expect(headerList(response)).toEqual(REFUSAL_HEADERS);
			expect(next).not.toHaveBeenCalled();
		}
	});

	test("subtle mismatches are cross-origin: scheme, port, subdomain", async () => {
		for (const origin of [
			"https://localhost:4321",
			"http://localhost:9999",
			"http://evil.localhost:4321",
		]) {
			const next = endpoint();
			const response = await runMiddleware(
				context("POST", "/cart/add", "/cart/add", { origin }),
				next,
			);
			expect(response.status).toBe(403);
			expect(next).not.toHaveBeenCalled();
		}
	});
});

describe("default-deny: a write route nobody listed is guarded too", () => {
	test.each(["POST", "PUT", "PATCH", "DELETE"])(
		"a cross-origin %s to an unlisted storefront path is refused",
		async (method) => {
			const next = endpoint();
			const response = await runMiddleware(
				context(method, "/some/future-endpoint", "/some/future-endpoint", { origin: EVIL }),
				next,
			);
			expect(response.status).toBe(403);
			expect(headerList(response)).toEqual(REFUSAL_HEADERS);
			expect(next).not.toHaveBeenCalled();
		},
	);
});

describe("exempt: the Stripe webhook is never origin-checked", () => {
	test("Stripe's own delivery (no Origin) reaches the endpoint", async () => {
		const next = endpoint();
		const response = await runMiddleware(
			context("POST", "/webhooks/stripe", "/webhooks/stripe"),
			next,
		);
		expect(response.status).toBe(299);
		expect(next).toHaveBeenCalledOnce();
	});

	test("even with a foreign Origin (a proxy that adds one) — its authority is the signature", async () => {
		for (const pathname of ["/webhooks/stripe", "/webhooks/stripe/"]) {
			const next = endpoint();
			const response = await runMiddleware(
				context("POST", pathname, "/webhooks/stripe", { origin: EVIL }),
				next,
			);
			expect(response.status).toBe(299);
			expect(next).toHaveBeenCalledOnce();
		}
	});
});

describe("what the check never touches", () => {
	test.each(["GET", "HEAD", "OPTIONS"])(
		"a cross-origin %s reaches the route — safe methods are not checked",
		async (method) => {
			for (const route of ["/checkout/resume", "/cart", "/products"]) {
				const next = endpoint();
				const response = await runMiddleware(context(method, route, route, { origin: EVIL }), next);
				expect(response.status).toBe(299);
				expect(next).toHaveBeenCalledOnce();
			}
		},
	);

	test.each([
		// EmDash's authenticated API (X-EmDash-Request) and its public API
		// (checkPublicCsrf), both checked by EmDash before this middleware runs.
		["/_emdash/api/content/posts", "/_emdash/api/[...path]"],
		["/_emdash/api/plugins/otta/storefront/cart/add", "/_emdash/api/plugins/[...path]"],
		// OAuth protocol routes EmDash leaves open to cross-origin on purpose.
		["/_emdash/api/oauth/token", "/_emdash/api/oauth/token"],
		["/_emdash/admin", "/_emdash/admin"],
		["/_server-islands/Island", "/_server-islands/[name]"],
	])("a cross-origin POST %s is left to EmDash / Astro", async (pathname, routePattern) => {
		const next = endpoint();
		const response = await runMiddleware(
			context("POST", pathname, routePattern, { origin: EVIL }),
			next,
		);
		expect(response.status).toBe(299);
		expect(next).toHaveBeenCalledOnce();
	});

	test("the decision itself, unit by unit", () => {
		expect(originGuardApplies("POST", "/cart/add", "/cart/add")).toBe(true);
		expect(originGuardApplies("post", "/cart/add", "/cart/add")).toBe(true);
		expect(originGuardApplies("get", "/cart/add", "/cart/add")).toBe(false);
		expect(originGuardApplies("POST", "/_emdash/api/x", "/_emdash/api/[...path]")).toBe(false);
		expect(originGuardApplies("POST", "/webhooks/stripe", "/webhooks/stripe")).toBe(false);
		// An exemption is by ROUTE: a look-alike path served by another route is not exempt.
		expect(originGuardApplies("POST", "/webhooks/stripe", "/404")).toBe(true);
	});
});

describe("the check lives in ONE place", () => {
	test("the middleware runs it before anything else", () => {
		const source = readFileSync(path.join(SRC, "middleware.ts"), "utf8");
		const body = source.slice(source.indexOf("defineMiddleware(async"));
		const guard = body.indexOf("rejectCrossOrigin(context)");
		expect(guard).toBeGreaterThan(-1);
		expect(guard).toBeLessThan(body.indexOf("request.method"));
		expect(guard).toBeLessThan(body.indexOf("next()"));
	});

	test("no endpoint carries its own copy any more", () => {
		const pages = path.join(SRC, "pages");
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (
					/from "[^"]*origin-guard\.js"|rejectCrossOrigin\(context\)/.test(
						readFileSync(full, "utf8"),
					)
				) {
					offenders.push(path.relative(pages, full));
				}
			}
		};
		walk(pages);
		expect(offenders).toEqual([]);
	});
});
