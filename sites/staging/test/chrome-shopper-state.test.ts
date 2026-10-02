/**
 * The header's shopper state (QA U-12, U-14): the cart count on every storefront
 * page, not only /cart, and a signed-in header that differs from a signed-out one.
 *
 * WHY THIS IS A CACHING QUESTION FIRST. Both facts are one visitor's. A page that
 * renders them must never be stored and replayed to anyone else, and a page that
 * IS stored must not carry them. So:
 *  - the shell reads them ONLY for a request that carries the cookie they depend
 *    on (`otta_cart` for the count, `otta_session` for signed-in) — a visitor with
 *    neither gets the neutral header, no commerce call, and a page whose caching
 *    is untouched;
 *  - the middleware sends any HTML page rendered for such a request
 *    `private, no-store` and out of Astro's route cache (middleware.ts "TWO
 *    CACHES"), so a per-visitor header is never stored;
 *  - the signed-in header names no email ("Your account"), so even the private
 *    copy carries no address.
 * No client JS is added (ADR-0012 decision 2 stands).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { STOREFRONT_CART_READ_ROUTE } from "@otta-sh/plugin";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(handler: T): T => handler,
}));

import { readCartCount } from "../src/lib/chrome-state.js";
import { ACCOUNT_NAV_ITEM, ACCOUNT_NAV_SIGNED_IN_LABEL, withAccountLink } from "../src/lib/nav.js";
import { onRequest, PER_SHOPPER_NO_STORE } from "../src/middleware.js";
import { themeFor } from "../src/themes/registry.js";
import { SRC } from "./theme-views.js";

const SITE = "http://localhost:4321";

function scripted(answers: Record<string, unknown>): { handler: never; calls: string[] } {
	const calls: string[] = [];
	const handler = async (_id: string, _method: string, route: string) => {
		const name = route.replace(/^\//, "");
		calls.push(name);
		return name in answers ? { success: true, data: answers[name] } : { success: false };
	};
	return { handler: handler as never, calls };
}

function countRequest(handler: unknown, cartCookie: string | null) {
	return {
		cookies: {
			get: (name: string) =>
				name === "otta_cart" && cartCookie !== null ? { value: cartCookie } : undefined,
		},
		locals: { emdash: { handlePublicPluginApiRoute: handler } } as never,
		url: new URL("/products", SITE),
	};
}

const cart = (state: string, qtys: number[]) => ({
	ok: true,
	cart: {
		cartId: "cart-1",
		state,
		orderId: null,
		currency: "USD",
		lines: qtys.map((qty, n) => ({
			lineId: `l-${String(n)}`,
			sku: `SKU-${String(n)}`,
			productId: null,
			qty,
			reservationId: null,
			expiresAt: null,
		})),
	},
	pricing: null,
});

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("readCartCount — the header's count, one guarded read that fails soft", () => {
	test("no cart cookie: no count and NO dispatch", async () => {
		const { handler, calls } = scripted({});
		expect(await readCartCount(countRequest(handler, null))).toBeNull();
		expect(calls).toEqual([]);
	});

	test("a live cart: its units", async () => {
		const { handler, calls } = scripted({ [STOREFRONT_CART_READ_ROUTE]: cart("active", [2, 1]) });
		expect(await readCartCount(countRequest(handler, "cart-1"))).toBe(3);
		expect(calls).toEqual([STOREFRONT_CART_READ_ROUTE]);
	});

	test("an empty, checked-out or vanished cart draws no badge", async () => {
		for (const answer of [
			cart("active", []),
			cart("checked_out", [2]),
			{ ok: false, reason: "CART_NOT_FOUND" },
		]) {
			const { handler } = scripted({ [STOREFRONT_CART_READ_ROUTE]: answer });
			expect(await readCartCount(countRequest(handler, "cart-1"))).toBeNull();
		}
	});

	test("BUSY, a failed read or no dispatcher is no count — never an error, never a 503", async () => {
		const busy = scripted({
			[STOREFRONT_CART_READ_ROUTE]: { ok: false, error: "BUSY", retryable: true },
		});
		expect(await readCartCount(countRequest(busy.handler, "cart-1"))).toBeNull();
		expect(busy.calls).toHaveLength(1); // ONE read: chrome is not worth a retry
		expect(await readCartCount(countRequest(scripted({}).handler, "cart-1"))).toBeNull();
		expect(await readCartCount(countRequest(undefined, "cart-1"))).toBeNull();
	});
});

describe("the account link says when the shopper is signed in — and never who", () => {
	test("signed in, the theme's own Account entry reads 'Your account'", () => {
		expect(withAccountLink([], true)).toEqual([
			{ label: ACCOUNT_NAV_SIGNED_IN_LABEL, url: ACCOUNT_NAV_ITEM.url },
		]);
		expect(ACCOUNT_NAV_SIGNED_IN_LABEL).toBe("Your account");
	});

	test("signed out (or not known), it stays the neutral 'Account'", () => {
		expect(withAccountLink([], false)).toEqual([ACCOUNT_NAV_ITEM]);
		expect(withAccountLink([])).toEqual([ACCOUNT_NAV_ITEM]);
	});

	test("an operator's own account link keeps the operator's words", () => {
		const menu = [{ label: "My stuff", url: "/account/orders" }];
		expect(withAccountLink(menu, true)).toEqual(menu);
	});
});

// ── caching: a header drawn for one visitor is never stored ─────────────────

type Handler = (ctx: unknown, next: () => Promise<Response>) => Promise<Response>;
const runMiddleware = onRequest as unknown as Handler;
const page = (type = "text/html"): Promise<Response> =>
	Promise.resolve(
		new Response("<html></html>", {
			headers: { "Content-Type": type, "Cache-Control": "public, max-age=60" },
		}),
	);

function middlewareContext(cookies: Record<string, string>, method = "GET") {
	const url = new URL("/products", SITE);
	return {
		request: new Request(url, { method }),
		url,
		cookies: {
			get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined),
			set: vi.fn(),
			delete: vi.fn(),
		},
		locals: {},
		cache: { set: vi.fn() },
	};
}

describe("the middleware keeps a shopper-state page private", () => {
	test("Tempered draws the shopper's state in its chrome (the opt-in this rests on)", () => {
		expect(themeFor("tempered").chrome?.shopperState).toBe(true);
	});

	test.each([
		["a cart cookie", { otta_cart: "cart-1" }],
		["a session cookie", { otta_session: "sess-1" }],
		["both", { otta_cart: "cart-1", otta_session: "sess-1" }],
	])("with %s, the HTML is private, no-store and out of the route cache", async (_label, jar) => {
		const ctx = middlewareContext(jar);
		const response = await runMiddleware(ctx, () => page());
		expect(response.headers.get("Cache-Control")).toBe(PER_SHOPPER_NO_STORE);
		expect(ctx.cache.set.mock.calls).toEqual([[false], [false]]);
	});

	test("with neither cookie, the page's caching is untouched — it rendered the neutral header", async () => {
		const ctx = middlewareContext({});
		const response = await runMiddleware(ctx, () => page());
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
		expect(ctx.cache.set).not.toHaveBeenCalled();
	});

	test("an empty cookie is no cookie", async () => {
		const ctx = middlewareContext({ otta_session: "", otta_cart: "" });
		const response = await runMiddleware(ctx, () => page());
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
	});

	test("a non-HTML response, and every write, are left alone", async () => {
		const json = await runMiddleware(middlewareContext({ otta_session: "s" }), () =>
			page("application/json"),
		);
		expect(json.headers.get("Cache-Control")).toBe("public, max-age=60");
		const post = await runMiddleware(middlewareContext({ otta_session: "s" }, "POST"), () =>
			page(),
		);
		expect(post.headers.get("Cache-Control")).toBe("public, max-age=60");
	});
});

describe("the shell reads the shopper's state only where it may", () => {
	const shell = readFileSync(path.join(SRC, "layouts/Storefront.astro"), "utf8");

	test("the count and the signed-in read come from their guarded helpers, behind the theme's opt-in", () => {
		expect(shell).toMatch(/chrome\?\.shopperState === true/);
		expect(shell).toContain("readCartCount(");
		expect(shell).toContain("signedInEmail(");
	});

	test("the signed-in state reaches the chrome as a boolean — the email never does", () => {
		const chromeModel = /const chrome: ChromeModel = \{[\s\S]*?\n\};/.exec(shell)?.[0] ?? "";
		expect(chromeModel).toMatch(/signedIn,/);
		expect(chromeModel).not.toMatch(/email/i);
	});
});
