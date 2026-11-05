/**
 * `/cart/add` with no cart yet mints one through `storefront/cart/create`. A
 * double-submitted first add sends two such requests at once, neither carrying
 * the cookie the other is about to set — so, unkeyed, each minted its own cart,
 * the add landed in one, and the shopper kept whichever cookie arrived last
 * (issue #39).
 *
 * The create now carries the add's own key, but ONLY when that key is this
 * visitor's alone. A create key is a bearer secret — whoever presents it gets the
 * cart — and the one key a page renders (the no-script fallback, ADR-0039) may be
 * served to every visitor from a shared cache. So the form posts that rendered key
 * a second time, as `renderedKey`, and the create is keyed only when the posted
 * key differs from it: the product page's script minted it for this submission.
 * A no-script add, or a form without `renderedKey`, creates unkeyed, as before.
 */
import {
	CART_COOKIE_NAME,
	STOREFRONT_CART_CREATE_ROUTE,
	STOREFRONT_CART_LINE_ADD_ROUTE,
} from "@urumi.ai/otta-plugin";
import type { APIContext } from "astro";
import { describe, expect, test, vi } from "vitest";

vi.mock("emdash", () => ({ getEmDashEntry: vi.fn() }));

import { POST } from "../src/pages/cart/add.js";

const SITE = "http://localhost:4321";

interface Call {
	route: string;
	body: Record<string, unknown>;
}

/**
 * A dispatcher whose `cart/create` behaves like the real one: the same key is the
 * same cart, and a create without a key always mints a new one. Shared between
 * requests, as the store is.
 */
function makeStore(): { handler: unknown; calls: Call[] } {
	const calls: Call[] = [];
	const byKey = new Map<string, string>();
	let minted = 0;
	const handler = async (_id: string, _method: string, routePath: string, request: Request) => {
		const route = routePath.replace(/^\//, "");
		const body = (await request.json()) as Record<string, unknown>;
		calls.push({ route, body });
		if (route === STOREFRONT_CART_CREATE_ROUTE) {
			const key = body["idempotencyKey"];
			let cartId = typeof key === "string" ? byKey.get(key) : undefined;
			if (cartId === undefined) {
				minted += 1;
				cartId = `cart-${minted}`;
				if (typeof key === "string") byKey.set(key, cartId);
			}
			return {
				success: true,
				data: {
					ok: true,
					cartId,
					cookie: {
						name: CART_COOKIE_NAME,
						value: cartId,
						httpOnly: true,
						secure: true,
						sameSite: "lax",
						path: "/",
						maxAgeSeconds: 60,
					},
				},
			};
		}
		if (route === STOREFRONT_CART_LINE_ADD_ROUTE) {
			return {
				success: true,
				data: { ok: true, line: { lineId: "l1", sku: body["sku"], qty: 1 } },
			};
		}
		return { success: false };
	};
	return { handler, calls };
}

/** One cookieless visitor's POST; returns the cart cookie the response set. */
async function add(
	handler: unknown,
	form: Record<string, string>,
): Promise<{ status: number; cartCookie: string | undefined }> {
	const url = new URL("/cart/add", SITE);
	const request = new Request(url, {
		method: "POST",
		headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ sku: "SKU-1", returnTo: "/products/mug", ...form }).toString(),
	});
	const jar = new Map<string, string>();
	const context = {
		request,
		url,
		cookies: {
			get: (name: string) => {
				const value = jar.get(name);
				return value === undefined ? undefined : { value };
			},
			set: (name: string, value: string) => jar.set(name, value),
			delete: (name: string) => jar.delete(name),
		},
		locals: { emdash: { handlePublicPluginApiRoute: handler } },
		redirect: (path: string, status = 302) =>
			new Response(null, { status, headers: { location: path } }),
	} as unknown as APIContext;
	const response = await POST(context);
	return { status: response.status, cartCookie: jar.get(CART_COOKIE_NAME) };
}

const creates = (calls: Call[]) =>
	calls.filter((c) => c.route === STOREFRONT_CART_CREATE_ROUTE).map((c) => c.body);

describe("/cart/add with no cart yet — the create's idempotency key (#39)", () => {
	test("a double-submit of one scripted press lands in ONE cart: both answers set the same cookie", async () => {
		const { handler, calls } = makeStore();
		const press = { idempotencyKey: "minted-by-script", renderedKey: "rendered-on-page" };

		const [first, second] = await Promise.all([add(handler, press), add(handler, press)]);

		expect(first.status).toBe(303);
		expect(second.status).toBe(303);
		expect(first.cartCookie).toBe("cart-1");
		expect(second.cartCookie).toBe("cart-1");
		expect(creates(calls)).toEqual([
			{ idempotencyKey: "minted-by-script" },
			{ idempotencyKey: "minted-by-script" },
		]);
	});

	test("two scripted presses (two keys) are two adds: each mints its own cart", async () => {
		const { handler } = makeStore();
		const a = await add(handler, { idempotencyKey: "press-a", renderedKey: "rendered" });
		const b = await add(handler, { idempotencyKey: "press-b", renderedKey: "rendered" });
		expect(a.cartCookie).not.toBe(b.cartCookie);
	});

	// A shared cache can hand every visitor the same rendered page, and with no
	// script each of them posts its rendered key. Keyed on it, the second visitor
	// would be handed the first visitor's cart.
	test("the RENDERED key (no script) is never sent: a second visitor posting it never gets the first's cart", async () => {
		const { handler, calls } = makeStore();
		const cached = { idempotencyKey: "rendered-on-page", renderedKey: "rendered-on-page" };

		const visitorA = await add(handler, cached);
		const visitorB = await add(handler, cached);

		expect(visitorA.cartCookie).toBe("cart-1");
		expect(visitorB.cartCookie).toBe("cart-2");
		expect(creates(calls)).toEqual([{}, {}]);
	});

	test("a form with no renderedKey (a page rendered before it existed) creates unkeyed", async () => {
		const { handler, calls } = makeStore();
		await add(handler, { idempotencyKey: "who-minted-this" });
		expect(creates(calls)).toEqual([{}]);
	});

	test("the add itself still carries the form's key, keyed create or not", async () => {
		const { handler, calls } = makeStore();
		await add(handler, { idempotencyKey: "minted-by-script", renderedKey: "rendered" });
		await add(handler, { idempotencyKey: "rendered", renderedKey: "rendered" });
		expect(
			calls
				.filter((c) => c.route === STOREFRONT_CART_LINE_ADD_ROUTE)
				.map((c) => c.body["idempotencyKey"]),
		).toEqual(["minted-by-script", "rendered"]);
	});
});
