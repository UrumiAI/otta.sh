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
import { STOREFRONT_CART_READ_ROUTE, STOREFRONT_SHOPPER_STATE_ROUTE } from "@otta-sh/plugin";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(handler: T): T => handler,
}));

import { chromeCartCount, readShopperState } from "../src/lib/chrome-state.js";
import { ACCOUNT_NAV_ITEM, ACCOUNT_NAV_SIGNED_IN_LABEL, withAccountLink } from "../src/lib/nav.js";
import { onRequest, PER_SHOPPER_NO_STORE } from "../src/middleware.js";
import { themeFor } from "../src/themes/registry.js";
import { SRC } from "./theme-views.js";

const SITE = "http://localhost:4321";

interface Call {
	route: string;
	body: Record<string, unknown>;
}

function scripted(answers: Record<string, unknown>): { handler: never; calls: Call[] } {
	const calls: Call[] = [];
	const handler = async (_id: string, _method: string, route: string, request: Request) => {
		const name = route.replace(/^\//, "");
		calls.push({ route: name, body: (await request.json()) as Record<string, unknown> });
		return name in answers ? { success: true, data: answers[name] } : { success: false };
	};
	return { handler: handler as never, calls };
}

function shopperRequest(handler: unknown, jar: Record<string, string>) {
	return {
		cookies: { get: (name: string) => (name in jar ? { value: jar[name] ?? "" } : undefined) },
		locals: { emdash: { handlePublicPluginApiRoute: handler } } as never,
		url: new URL("/products", SITE),
	};
}

const BOTH = { count: true, signedIn: true } as const;
const answer = (count: number | null, signedIn: boolean, state = "active") => ({
	[STOREFRONT_SHOPPER_STATE_ROUTE]: {
		ok: true,
		cart: count === null ? null : { state, count },
		signedIn,
	},
});

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/* Review (Workers Free: 50 D1 queries per invocation): the header used the full
   priced cart read plus an account/me read. It is now ONE dispatch of the lean
   storefront/shopper-state route (at most two document reads, pinned in the
   plugin's shopper-state-route.test.ts), without the BUSY retry, per page. */
describe("readShopperState — the header's facts in ONE lean dispatch per page, failing soft", () => {
	test("neither cookie: no dispatch at all", async () => {
		const { handler, calls } = scripted(answer(3, true));
		expect(await readShopperState(shopperRequest(handler, {}), BOTH)).toEqual({
			cartCount: null,
			signedIn: false,
		});
		expect(calls).toEqual([]);
	});

	test("cart and session: exactly one dispatch, to the lean route, carrying both", async () => {
		const { handler, calls } = scripted(answer(3, true));
		const jar = { otta_cart: "cart-1", otta_session: "sess-1" };
		expect(await readShopperState(shopperRequest(handler, jar), BOTH)).toEqual({
			cartCount: 3,
			signedIn: true,
		});
		expect(calls).toEqual([
			{
				route: STOREFRONT_SHOPPER_STATE_ROUTE,
				body: { cartId: "cart-1", sessionToken: "sess-1" },
			},
		]);
		expect(calls.map((call) => call.route)).not.toContain(STOREFRONT_CART_READ_ROUTE);
	});

	test("only what the page did not already know is asked for", async () => {
		const { handler, calls } = scripted(answer(2, false));
		const jar = { otta_cart: "cart-1", otta_session: "sess-1" };
		await readShopperState(shopperRequest(handler, jar), { count: false, signedIn: true });
		expect(calls[0]?.body).toEqual({ sessionToken: "sess-1" });
		await readShopperState(shopperRequest(handler, jar), { count: true, signedIn: false });
		expect(calls[1]?.body).toEqual({ cartId: "cart-1" });
		calls.length = 0;
		await readShopperState(shopperRequest(handler, jar), { count: false, signedIn: false });
		expect(calls).toEqual([]);
	});

	test("an empty, checked-out or missing cart draws no badge — the same rule /cart follows", async () => {
		for (const [count, state] of [
			[0, "active"],
			[2, "checked_out"],
			[null, "active"],
		] as const) {
			const { handler } = scripted(answer(count, false, state));
			const read = await readShopperState(shopperRequest(handler, { otta_cart: "c" }), BOTH);
			expect(read.cartCount).toBeNull();
		}
		expect(chromeCartCount(0)).toBeNull();
		expect(chromeCartCount(null)).toBeNull();
		expect(chromeCartCount(4)).toBe(4);
	});

	test("BUSY, a failed read or no dispatcher: nothing drawn, ONE attempt — never an error, never a 503", async () => {
		const busy = scripted({
			[STOREFRONT_SHOPPER_STATE_ROUTE]: { ok: false, error: "BUSY", retryable: true },
		});
		const jar = { otta_cart: "cart-1", otta_session: "s" };
		expect(await readShopperState(shopperRequest(busy.handler, jar), BOTH)).toEqual({
			cartCount: null,
			signedIn: false,
		});
		expect(busy.calls).toHaveLength(1);
		expect(await readShopperState(shopperRequest(scripted({}).handler, jar), BOTH)).toEqual({
			cartCount: null,
			signedIn: false,
		});
		expect(await readShopperState(shopperRequest(undefined, jar), BOTH)).toEqual({
			cartCount: null,
			signedIn: false,
		});
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

	test("ONE lean read per page, behind the theme's opt-in — no full cart read, no account/me", () => {
		expect(shell).toMatch(/chrome\?\.shopperState === true/);
		expect(shell.match(/readShopperState\(/g)).toHaveLength(1);
		expect(shell).not.toContain("readCartCount(");
		expect(shell).not.toContain("signedInEmail(");
	});

	test("the signed-in state reaches the chrome as a boolean — the email never does", () => {
		const chromeModel = /const chrome: ChromeModel = \{[\s\S]*?\n\};/.exec(shell)?.[0] ?? "";
		expect(chromeModel).toMatch(/signedIn,/);
		expect(chromeModel).not.toMatch(/email/i);
	});

	test("every page's badge follows one rule: no badge for an empty cart, /cart included", () => {
		expect(shell).toMatch(/const cartCount = chromeCartCount\(/);
	});
});
