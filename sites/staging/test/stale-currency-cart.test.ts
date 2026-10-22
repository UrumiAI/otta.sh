/**
 * Issue #440 — a cart opened before the operator switched the store currency.
 *
 * The cart keeps its old currency (a cart is never rewritten), so nothing the
 * shop now sells can be checked out of it, and the only advice the shopper got
 * was "One of the items in your cart is no longer available for purchase." The
 * cart page now says what happened — in both currencies — and offers ONE way out:
 * a new cart in the store currency (`POST /cart/switch-currency`), which releases
 * the old cart's holds. Nothing is converted and nothing is carried over, and the
 * copy says so before the shopper clicks.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { STOREFRONT_CART_CREATE_ROUTE } from "@urumi.ai/otta-plugin";
import type { APIContext } from "astro";
import { describe, expect, test } from "vitest";
import { CHECKOUT_COOKIE_NAME } from "../src/lib/checkout-cookie.js";
import { staleCurrencyNotice } from "../src/lib/stale-currency.js";
import { POST as SWITCH_POST } from "../src/pages/cart/switch-currency.js";
import { SRC } from "./theme-views.js";

const SITE = "http://localhost:4321";

interface CookieOp {
	op: "set" | "delete";
	name: string;
	value?: string;
}

function makeContext(
	createResult: unknown,
	cartCookie: string | null = "cart-old",
): {
	context: APIContext;
	calls: Array<{ route: string; body: Record<string, unknown> }>;
	cookieOps: CookieOp[];
} {
	const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
	const handler = async (_id: string, _method: string, routePath: string, request: Request) => {
		const route = routePath.replace(/^\//, "");
		calls.push({ route, body: (await request.json()) as Record<string, unknown> });
		if (route === STOREFRONT_CART_CREATE_ROUTE) {
			return createResult === null ? { success: false } : { success: true, data: createResult };
		}
		return { success: false };
	};
	const url = new URL("/cart/switch-currency", SITE);
	const cookieStore = new Map<string, string>();
	if (cartCookie !== null) cookieStore.set("otta_cart", cartCookie);
	const cookieOps: CookieOp[] = [];
	const context = {
		request: new Request(url, { method: "POST", headers: { origin: SITE } }),
		url,
		cookies: {
			get: (name: string) => {
				const value = cookieStore.get(name);
				return value === undefined ? undefined : { value };
			},
			set: (name: string, value: string) => {
				cookieOps.push({ op: "set", name, value });
				cookieStore.set(name, value);
			},
			delete: (name: string) => {
				cookieOps.push({ op: "delete", name });
				cookieStore.delete(name);
			},
		},
		locals: { emdash: { handlePublicPluginApiRoute: handler } },
		redirect: (location: string, status = 302) =>
			new Response(null, { status, headers: { location } }),
	} as unknown as APIContext;
	return { context, calls, cookieOps };
}

const REPLACED = {
	ok: true,
	cartId: "cart-new",
	cookie: {
		name: "otta_cart",
		value: "cart-new",
		httpOnly: true,
		secure: true,
		sameSite: "lax",
		path: "/",
		maxAgeSeconds: 60,
	},
};

describe("staleCurrencyNotice — the cart page's copy", () => {
	const notice = staleCurrencyNotice({ cartCurrency: "USD", storeCurrency: "EUR" });

	test("names both currencies, and the action names the new one", () => {
		expect(notice.lead).toBe("This shop now sells in EUR.");
		expect(notice.body).toContain("USD");
		expect(notice.body).toContain("EUR");
		expect(notice.action).toBe("Start a new cart in EUR");
	});

	test("says what the action costs before it is clicked: the items are not carried over", () => {
		expect(notice.body).toMatch(/add (them|your items) again/);
		expect(notice.body).toMatch(/released/);
	});

	test("never promises a converted price", () => {
		expect(notice.body).not.toMatch(/convert/i);
	});
});

describe("POST /cart/switch-currency", () => {
	test("asks for the cookie cart's stale-currency replacement, sets its cookie, drops the stash, and 303s to /products", async () => {
		const { context, calls, cookieOps } = makeContext(REPLACED);
		const response = await SWITCH_POST(context);
		expect(calls).toEqual([
			{ route: STOREFRONT_CART_CREATE_ROUTE, body: { replacesStaleCurrencyCartId: "cart-old" } },
		]);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/products");
		expect(cookieOps).toContainEqual({ op: "set", name: "otta_cart", value: "cart-new" });
		expect(cookieOps).toContainEqual({ op: "delete", name: CHECKOUT_COOKIE_NAME });
	});

	test("no cart cookie: nothing to replace, no dispatch, back to /cart", async () => {
		const { context, calls } = makeContext(REPLACED, null);
		const response = await SWITCH_POST(context);
		expect(calls).toHaveLength(0);
		expect(response.headers.get("location")).toBe("/cart");
	});

	test("a cart already in the store currency is left alone: back to /cart, cookie kept", async () => {
		const { context, cookieOps } = makeContext({ ok: false, reason: "CART_CURRENCY_CURRENT" });
		const response = await SWITCH_POST(context);
		expect(response.headers.get("location")).toBe("/cart");
		expect(cookieOps).toEqual([]);
	});

	test("a vanished cart drops the cookie, so the next add starts a fresh cart", async () => {
		const { context, cookieOps } = makeContext({ ok: false, reason: "CART_NOT_FOUND" });
		const response = await SWITCH_POST(context);
		expect(response.headers.get("location")).toBe("/cart?error=CART_NOT_FOUND");
		expect(cookieOps).toContainEqual({ op: "delete", name: "otta_cart" });
	});

	test("a cart checked out meanwhile keeps its cookie and is told so on /cart", async () => {
		const { context, cookieOps } = makeContext({ ok: false, reason: "CART_CHECKED_OUT" });
		const response = await SWITCH_POST(context);
		expect(response.headers.get("location")).toBe("/cart?error=CART_CHECKED_OUT");
		expect(cookieOps).toEqual([]);
	});

	test("a failed dispatch changes nothing and says the service is unavailable", async () => {
		const { context, cookieOps } = makeContext(null);
		const response = await SWITCH_POST(context);
		expect(response.headers.get("location")).toBe("/cart?error=SERVICE_UNAVAILABLE");
		expect(cookieOps).toEqual([]);
	});

	test("busy is the busy 503, not a redirect", async () => {
		const { context } = makeContext({ ok: false, error: "BUSY" });
		const response = await SWITCH_POST(context);
		expect(response.status).toBe(503);
	});
});

describe("the cart page wires the notice", () => {
	const page = readFileSync(path.join(SRC, "pages/cart/index.astro"), "utf8");
	const view = readFileSync(path.join(SRC, "themes/tempered/CartView.astro"), "utf8");

	test("the page builds the notice from the read's staleCurrency, and only for a live cart", () => {
		expect(page).toContain("staleCurrencyNotice(");
		expect(page).toMatch(/result\.staleCurrency/);
	});

	test("the view posts the switch, with the notice's own copy", () => {
		expect(view).toMatch(/<form method="POST" action="\/cart\/switch-currency"/);
		expect(view).toContain("{staleCurrency.action}");
	});
});
