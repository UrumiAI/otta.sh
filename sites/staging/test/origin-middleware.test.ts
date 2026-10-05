/**
 * The origin check runs ONCE, in `src/middleware.ts`, for every state-changing
 * storefront route (issue #376 part 3; ADR-0006's CSRF section).
 *
 * It used to be a `rejectCrossOrigin(context)` call each endpoint made first.
 * Moving it must change nothing a browser can observe, so this suite pins:
 *  - a TABLE over every non-GET route under `src/pages`, discovered from the
 *    source, saying guarded or exempt — a new write route that is in neither
 *    column fails here, so the choice is always explicit;
 *  - a guarded route's cross-origin refusal is byte-for-byte the one its
 *    endpoint sent (status, body, every header), and the endpoint never runs;
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
 *  Astro matched; it defaults to the path (true for every static route here). */
function context(
	method: string,
	pathname: string,
	opts: { origin?: string | null; routePattern?: string; cookies?: Record<string, string> } = {},
) {
	const url = new URL(pathname, SITE);
	const headers: Record<string, string> = {};
	if (opts.origin !== undefined && opts.origin !== null) headers["origin"] = opts.origin;
	const jar = opts.cookies ?? {};
	return {
		request: new Request(url, { method, headers }),
		url,
		routePattern: opts.routePattern ?? url.pathname,
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

/** Every response header, lower-cased and sorted — "byte-identical" means this
 *  list, the status and the body all match. */
function headerList(response: Response): Array<[string, string]> {
	return [...response.headers.entries()].toSorted(([a], [b]) => a.localeCompare(b));
}

// ── the route table ────────────────────────────────────────────────────────

/** What each endpoint's own refusal was before the move: `rejectCrossOrigin`'s
 *  bare 403 (`text/plain;charset=UTF-8`), plus the headers the three checkout
 *  endpoints wrap EVERY response in (`withoutReferrer`; resume also
 *  `privateResponse`). */
const BARE: Array<[string, string]> = [["content-type", "text/plain;charset=UTF-8"]];
const NO_REFERRER: Array<[string, string]> = [...BARE, ["referrer-policy", "no-referrer"]];
const RESUME: Array<[string, string]> = [["cache-control", PRIVATE_NO_STORE], ...NO_REFERRER];

/** Every non-GET route the site serves, and what the middleware does with a
 *  cross-origin request to it. */
const GUARDED: ReadonlyMap<string, Array<[string, string]>> = new Map([
	["/account/login/request", BARE],
	["/account/logout", BARE],
	["/account/verify/confirm", BARE],
	["/cart/add", BARE],
	["/cart/remove", BARE],
	["/cart/update", BARE],
	["/checkout/new-cart", NO_REFERRER],
	["/checkout/place", NO_REFERRER],
	["/checkout/resume", RESUME],
]);
const EXEMPT: readonly string[] = ["/webhooks/stripe"];

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
			const source = readFileSync(full, "utf8");
			if (!/export (const|async function|function) (POST|PUT|PATCH|DELETE|ALL)\b/.test(source)) {
				continue;
			}
			const route = `/${path.relative(pages, full)}`
				.replace(/\.(ts|js|astro)$/, "")
				.replace(/\/index$/, "");
			routes.push(route === "" ? "/" : route);
		}
	};
	walk(pages);
	return routes.toSorted();
}

describe("the route table covers every write route the site serves", () => {
	test("each non-GET route is listed as guarded or exempt — never neither, never both", () => {
		expect(writeRoutes()).toEqual([...GUARDED.keys(), ...EXEMPT].toSorted());
		for (const route of EXEMPT) expect(GUARDED.has(route)).toBe(false);
	});

	test("the exemption list in the code is exactly the table's", () => {
		expect([...ORIGIN_GUARD_EXEMPT_ROUTES.keys()].toSorted()).toEqual([...EXEMPT].toSorted());
	});
});

describe("a guarded route refuses a cross-origin write exactly as its endpoint did", () => {
	test.each([...GUARDED.entries()])(
		"cross-origin POST %s → the same 403, and the endpoint never runs",
		async (route, headers) => {
			const next = endpoint();
			const response = await runMiddleware(context("POST", route, { origin: EVIL }), next);
			expect(response.status).toBe(403);
			expect(await response.text()).toBe(CROSS_ORIGIN_REFUSAL_BODY);
			expect(headerList(response)).toEqual(headers);
			expect(next).not.toHaveBeenCalled();
		},
	);

	test.each([...GUARDED.keys()])(
		"Origin: null (an opaque origin) on %s is refused",
		async (route) => {
			const next = endpoint();
			const response = await runMiddleware(context("POST", route, { origin: "null" }), next);
			expect(response.status).toBe(403);
			expect(next).not.toHaveBeenCalled();
		},
	);

	test.each([...GUARDED.keys()])(
		"a same-origin POST %s reaches the endpoint untouched",
		async (route) => {
			const next = endpoint();
			const response = await runMiddleware(context("POST", route, { origin: SITE }), next);
			expect(response.status).toBe(299);
			expect(next).toHaveBeenCalledOnce();
		},
	);

	test.each([...GUARDED.keys()])(
		"a POST %s with NO Origin reaches the endpoint (curl / server-to-server, as before)",
		async (route) => {
			const next = endpoint();
			const response = await runMiddleware(context("POST", route, { origin: null }), next);
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
				context("POST", pathname, { origin: EVIL, routePattern }),
				next,
			);
			expect(response.status).toBe(403);
			expect(headerList(response)).toEqual(NO_REFERRER);
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
			const response = await runMiddleware(context("POST", "/cart/add", { origin }), next);
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
				context(method, "/some/future-endpoint", { origin: EVIL }),
				next,
			);
			expect(response.status).toBe(403);
			expect(headerList(response)).toEqual(BARE);
			expect(next).not.toHaveBeenCalled();
		},
	);
});

describe("exempt: the Stripe webhook is never origin-checked", () => {
	test("Stripe's own delivery (no Origin) reaches the endpoint", async () => {
		const next = endpoint();
		const response = await runMiddleware(context("POST", "/webhooks/stripe"), next);
		expect(response.status).toBe(299);
		expect(next).toHaveBeenCalledOnce();
	});

	test("even with a foreign Origin (a proxy that adds one) — its authority is the signature", async () => {
		for (const pathname of ["/webhooks/stripe", "/webhooks/stripe/"]) {
			const next = endpoint();
			const response = await runMiddleware(
				context("POST", pathname, { origin: EVIL, routePattern: "/webhooks/stripe" }),
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
				const response = await runMiddleware(context(method, route, { origin: EVIL }), next);
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
			context("POST", pathname, { origin: EVIL, routePattern }),
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
