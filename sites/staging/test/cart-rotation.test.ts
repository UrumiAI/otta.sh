/**
 * A cart that has become a FINISHED order is spent: it can never produce another
 * order, and every add against it answers CART_CHECKED_OUT. Before this, the
 * `otta_cart` cookie kept naming it after a paid order, so "Add to cart" failed
 * until the shopper found "Start a new cart" — whose copy, rightly, warns that it
 * clears any payment still in progress.
 *
 * The rule these cases pin: the site forgets a cart ONLY when it can see that the
 * order the cart became is no longer `pending`. A pending order is a payment that
 * may still happen — `/orders/<id>`'s "Complete payment" goes back through
 * `/checkout`, which rebuilds from this very cookie — so that cart is kept, and
 * the shopper is shown the way out instead (cart-view.ts, cart/index.astro).
 * A cart that names no order, or one this site cannot read, is kept too: not
 * knowing is not proof that nothing is in flight.
 */
import {
	CART_COOKIE_NAME,
	STOREFRONT_CART_CREATE_ROUTE,
	STOREFRONT_CART_LINE_ADD_ROUTE,
	STOREFRONT_CART_READ_ROUTE,
	STOREFRONT_ORDER_ROUTE,
} from "@otta-sh/plugin";
import type { APIContext } from "astro";
import { describe, expect, test, vi } from "vitest";

vi.mock("emdash", () => ({ getEmDashEntry: vi.fn() }));

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { forgetSpentCart, isSpentCart } from "../src/lib/cart-rotation.js";
import { keepPrivate } from "../src/lib/no-store.js";
import { cartErrorAction } from "../src/lib/error-messages.js";
import { splitAstro, templateOf } from "./astro-source.js";
import { CHECKOUT_COOKIE_NAME } from "../src/lib/checkout-cookie.js";
import { POST as ADD_POST } from "../src/pages/cart/add.js";

const SITE = "http://localhost:4321";

interface Call {
	route: string;
	body: Record<string, unknown>;
}

function cart(cartId: string, state: string, orderId: string | null) {
	return {
		ok: true,
		cart: { cartId, state, orderId, currency: "USD", lines: [] },
		pricing: { lines: [], allLinesPriced: true },
	};
}

function order(id: string, state: string) {
	return { ok: true, order: { id, state } };
}

/** Routes by name; `add` answers per cart id, so the retry on the NEW cart can
 *  succeed where the spent one refused. */
function makeHandler(results: {
	cartRead?: unknown;
	order?: unknown;
	addByCart?: Record<string, unknown>;
}): { handler: unknown; calls: Call[] } {
	const calls: Call[] = [];
	const handler = async (_id: string, _method: string, routePath: string, request: Request) => {
		const route = routePath.replace(/^\//, "");
		const body = (await request.json()) as Record<string, unknown>;
		calls.push({ route, body });
		const data =
			route === STOREFRONT_CART_READ_ROUTE
				? results.cartRead
				: route === STOREFRONT_ORDER_ROUTE
					? results.order
					: route === STOREFRONT_CART_CREATE_ROUTE
						? {
								ok: true,
								// Keyed like the real create: the same key is the same cart.
								cartId: newCartId(body["replacesCartId"]),
								cookie: {
									name: CART_COOKIE_NAME,
									value: newCartId(body["replacesCartId"]),
									httpOnly: true,
									secure: true,
									sameSite: "lax",
									path: "/",
									maxAgeSeconds: 3600,
								},
							}
						: route === STOREFRONT_CART_LINE_ADD_ROUTE
							? (results.addByCart?.[String(body["cartId"])] ?? {
									ok: true,
									line: { lineId: "l1", sku: body["sku"], qty: 1 },
								})
							: undefined;
		return data === undefined ? { success: false } : { success: true, data };
	};
	return { handler, calls };
}

/** The fake create's answer: a replacement is a function of the spent cart, as
 *  the plugin's server-derived key makes it; a plain create is a fresh cart. */
let unkeyed = 0;
function newCartId(replaces: unknown): string {
	return typeof replaces === "string" ? `new-for-${replaces}` : `cart-unkeyed-${String(++unkeyed)}`;
}

function makeJar(initial: Record<string, string>) {
	const jar = new Map(Object.entries(initial));
	const deleted: string[] = [];
	return {
		jar,
		deleted,
		cookies: {
			get: (name: string) => {
				const value = jar.get(name);
				return value === undefined ? undefined : { value };
			},
			set: (name: string, value: string) => {
				jar.set(name, value);
			},
			delete: (name: string) => {
				deleted.push(name);
				jar.delete(name);
			},
		},
	};
}

describe("isSpentCart — the one rule", () => {
	test("a cart whose order has left pending is spent", () => {
		for (const state of ["paid", "processing", "shipped", "expired", "failed", "cancelled"]) {
			expect(isSpentCart({ orderId: "ord-1" }, { id: "ord-1", state }), state).toBe(true);
		}
	});

	test("a cart whose order is still pending is NOT — the payment may still happen", () => {
		expect(isSpentCart({ orderId: "ord-1" }, { id: "ord-1", state: "pending" })).toBe(false);
	});

	test("a cart that became ANOTHER order, or names none, is not this order's to forget", () => {
		expect(isSpentCart({ orderId: "ord-2" }, { id: "ord-1", state: "paid" })).toBe(false);
		expect(isSpentCart({ orderId: null }, { id: "ord-1", state: "paid" })).toBe(false);
	});
});

describe("forgetSpentCart — the order confirmation page", () => {
	const url = new URL("/orders/ord-1", SITE);

	test("a paid order whose cart is still in the cookie: the cookie (and the stash) are dropped", async () => {
		const { handler, calls } = makeHandler({ cartRead: cart("cart-old", "checked_out", "ord-1") });
		const { cookies, deleted } = makeJar({ [CART_COOKIE_NAME]: "cart-old" });
		expect(
			await forgetSpentCart(
				{ cookies, handler: handler as never, url },
				{ id: "ord-1", state: "paid" },
			),
		).toBe(true);
		expect(deleted).toContain(CART_COOKIE_NAME);
		expect(deleted).toContain(CHECKOUT_COOKIE_NAME);
		expect(calls.map((c) => c.route)).toEqual([STOREFRONT_CART_READ_ROUTE]);
	});

	test("a PENDING order keeps its cart, and reads nothing", async () => {
		const { handler, calls } = makeHandler({ cartRead: cart("cart-old", "checked_out", "ord-1") });
		const { cookies, deleted } = makeJar({ [CART_COOKIE_NAME]: "cart-old" });
		expect(
			await forgetSpentCart(
				{ cookies, handler: handler as never, url },
				{ id: "ord-1", state: "pending" },
			),
		).toBe(false);
		expect(deleted).toEqual([]);
		expect(calls).toEqual([]);
	});

	test("a cookie naming a DIFFERENT cart (a new one, or another order's) is left alone", async () => {
		const { handler } = makeHandler({ cartRead: cart("cart-new", "active", null) });
		const { cookies, deleted } = makeJar({ [CART_COOKIE_NAME]: "cart-new" });
		expect(
			await forgetSpentCart(
				{ cookies, handler: handler as never, url },
				{ id: "ord-1", state: "paid" },
			),
		).toBe(false);
		expect(deleted).toEqual([]);
	});

	test("no cart cookie: nothing to read, nothing to forget", async () => {
		const { handler, calls } = makeHandler({});
		const { cookies } = makeJar({});
		expect(
			await forgetSpentCart(
				{ cookies, handler: handler as never, url },
				{ id: "ord-1", state: "paid" },
			),
		).toBe(false);
		expect(calls).toEqual([]);
	});

	test("a BUSY cart read is KEPT as well", async () => {
		const { handler } = makeHandler({ cartRead: { ok: false, error: "BUSY" } });
		const { cookies, deleted } = makeJar({ [CART_COOKIE_NAME]: "cart-old" });
		expect(
			await forgetSpentCart(
				{ cookies, handler: handler as never, url },
				{ id: "ord-1", state: "paid" },
			),
		).toBe(false);
		expect(deleted).toEqual([]);
	});

	test("an unreadable cart is KEPT — not knowing is not proof", async () => {
		const { handler } = makeHandler({ cartRead: { ok: false, error: "RENDER_FAILED" } });
		const { cookies, deleted } = makeJar({ [CART_COOKIE_NAME]: "cart-old" });
		expect(
			await forgetSpentCart(
				{ cookies, handler: handler as never, url },
				{ id: "ord-1", state: "paid" },
			),
		).toBe(false);
		expect(deleted).toEqual([]);
	});
});

function addContext(handler: unknown, jar: ReturnType<typeof makeJar>): APIContext {
	const url = new URL("/cart/add", SITE);
	const request = new Request(url, {
		method: "POST",
		headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			sku: "SKU-1",
			idempotencyKey: "idem-add",
			returnTo: "/products/bottle",
		}).toString(),
	});
	return {
		request,
		url,
		cookies: jar.cookies,
		locals: { emdash: { handlePublicPluginApiRoute: handler } },
		redirect: (target: string, status = 302) =>
			new Response(null, { status, headers: { location: target } }),
	} as unknown as APIContext;
}

const CHECKED_OUT = { ok: false, reason: "CART_CHECKED_OUT" };

describe("POST /cart/add on a checked-out cart", () => {
	test("the order is PAID: a new cart is started and the add lands in it — the shopper never sees the error", async () => {
		const { handler, calls } = makeHandler({
			cartRead: cart("cart-old", "checked_out", "ord-1"),
			order: order("ord-1", "paid"),
			addByCart: { "cart-old": CHECKED_OUT },
		});
		const jar = makeJar({ [CART_COOKIE_NAME]: "cart-old" });
		const response = await ADD_POST(addContext(handler, jar));

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/cart");
		expect(jar.jar.get(CART_COOKIE_NAME)).toBe("new-for-cart-old");
		// The replacement names the spent cart and the plugin keys it on that cart, so a
		// racing duplicate lands in it too.
		expect(
			calls.filter((c) => c.route === STOREFRONT_CART_CREATE_ROUTE).map((c) => c.body),
		).toEqual([{ replacesCartId: "cart-old" }]);
		const adds = calls.filter((c) => c.route === STOREFRONT_CART_LINE_ADD_ROUTE);
		expect(adds.map((c) => c.body["cartId"])).toEqual(["cart-old", "new-for-cart-old"]);
		// The SAME key, never an invented one: the refused attempt recorded nothing
		// (cartStoreContract pins that a CART_CHECKED_OUT add records no mutation), so the retry is the
		// add's first and only application.
		expect(adds.map((c) => c.body["idempotencyKey"])).toEqual(["idem-add", "idem-add"]);
	});

	test("an EXPIRED order's cart is spent too: rotated the same way", async () => {
		const { handler, calls } = makeHandler({
			cartRead: cart("cart-old", "checked_out", "ord-1"),
			order: order("ord-1", "expired"),
			addByCart: { "cart-old": CHECKED_OUT },
		});
		const jar = makeJar({ [CART_COOKIE_NAME]: "cart-old" });
		const response = await ADD_POST(addContext(handler, jar));
		expect(response.headers.get("location")).toBe("/cart");
		expect(jar.jar.get(CART_COOKIE_NAME)).toBe("new-for-cart-old");
		expect(
			calls.filter((c) => c.route === STOREFRONT_CART_LINE_ADD_ROUTE).map((c) => c.body["cartId"]),
		).toEqual(["cart-old", "new-for-cart-old"]);
	});

	// Two submits of the same add, both sent while the cookie still named the spent
	// cart (a double-click on a slow response). Both must end in ONE cart holding the
	// item, whichever response the browser applies last.
	test("a concurrent double-submit converges: both requests land in the same new cart", async () => {
		const { handler, calls } = makeHandler({
			cartRead: cart("cart-old", "checked_out", "ord-1"),
			order: order("ord-1", "paid"),
			addByCart: { "cart-old": CHECKED_OUT },
		});
		const first = makeJar({ [CART_COOKIE_NAME]: "cart-old" });
		const second = makeJar({ [CART_COOKIE_NAME]: "cart-old" });
		const responses = await Promise.all([
			ADD_POST(addContext(handler, first)),
			ADD_POST(addContext(handler, second)),
		]);
		expect(responses.map((r) => r.headers.get("location"))).toEqual(["/cart", "/cart"]);
		expect(first.jar.get(CART_COOKIE_NAME)).toBe("new-for-cart-old");
		expect(second.jar.get(CART_COOKIE_NAME)).toBe("new-for-cart-old");
		const retried = calls
			.filter((c) => c.route === STOREFRONT_CART_LINE_ADD_ROUTE && c.body["cartId"] !== "cart-old")
			.map((c) => [c.body["cartId"], c.body["idempotencyKey"]]);
		// Same cart, same key: the domain replays the second into the first's line.
		expect(retried).toEqual([
			["new-for-cart-old", "idem-add"],
			["new-for-cart-old", "idem-add"],
		]);
	});

	test.each([
		["BUSY", { ok: false, error: "BUSY" }],
		["not found", { ok: false, reason: "ORDER_NOT_FOUND" }],
		["unreachable", undefined],
	])(
		"an order read that fails (%s) keeps the cart — not knowing is not proof",
		async (_label, orderResult) => {
			const { handler, calls } = makeHandler({
				cartRead: cart("cart-old", "checked_out", "ord-1"),
				order: orderResult,
				addByCart: { "cart-old": CHECKED_OUT },
			});
			const jar = makeJar({ [CART_COOKIE_NAME]: "cart-old" });
			const response = await ADD_POST(addContext(handler, jar));
			expect(response.headers.get("location")).toBe("/products/bottle?error=CART_CHECKED_OUT");
			expect(jar.jar.get(CART_COOKIE_NAME)).toBe("cart-old");
			expect(jar.deleted).toEqual([]);
			expect(calls.some((c) => c.route === STOREFRONT_CART_CREATE_ROUTE)).toBe(false);
		},
	);

	test("the order is still PENDING: the cart is kept and the shopper is told — a payment may be in progress", async () => {
		const { handler, calls } = makeHandler({
			cartRead: cart("cart-old", "checked_out", "ord-1"),
			order: order("ord-1", "pending"),
			addByCart: { "cart-old": CHECKED_OUT },
		});
		const jar = makeJar({ [CART_COOKIE_NAME]: "cart-old" });
		const response = await ADD_POST(addContext(handler, jar));

		expect(response.headers.get("location")).toBe("/products/bottle?error=CART_CHECKED_OUT");
		expect(jar.jar.get(CART_COOKIE_NAME)).toBe("cart-old");
		expect(jar.deleted).toEqual([]);
		expect(calls.some((c) => c.route === STOREFRONT_CART_CREATE_ROUTE)).toBe(false);
	});

	test("a checked-out cart that names no order is kept as well", async () => {
		const { handler } = makeHandler({
			cartRead: cart("cart-old", "checked_out", null),
			addByCart: { "cart-old": CHECKED_OUT },
		});
		const jar = makeJar({ [CART_COOKIE_NAME]: "cart-old" });
		const response = await ADD_POST(addContext(handler, jar));
		expect(response.headers.get("location")).toBe("/products/bottle?error=CART_CHECKED_OUT");
		expect(jar.jar.get(CART_COOKIE_NAME)).toBe("cart-old");
	});
});

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const source = (relative: string): string => readFileSync(path.join(SRC, relative), "utf8");

// A CART_CHECKED_OUT that survives the rotation above is a cart whose payment may
// still be in progress. The product page must not leave the shopper at a dead
// end: the cart page is where that cart's order and "Start a new cart" are.
describe("the product page's CART_CHECKED_OUT notice offers the way out", () => {
	test("the token maps to a link to the cart; other tokens offer none", () => {
		expect(cartErrorAction("CART_CHECKED_OUT")).toEqual({
			href: "/cart",
			label: "Go to your cart",
		});
		expect(cartErrorAction("OUT_OF_STOCK")).toBeNull();
		expect(cartErrorAction("")).toBeNull();
	});

	test("the page decides the action; the view only links it, inside the notice", () => {
		expect(splitAstro(source("pages/products/[slug].astro")).frontmatter).toMatch(
			/errorAction: error !== null \? cartErrorAction\(error\) : null/,
		);
		expect(templateOf(source("themes/tempered/ProductView.astro"))).toMatch(
			/<Notice>[\s\S]*?\{model\.errorMessage\}[\s\S]*?<a href=\{model\.errorAction\.href\}>\{model\.errorAction\.label\}<\/a>[\s\S]*?<\/Notice>/,
		);
	});
});

describe("the order confirmation page forgets a spent cart", () => {
	// A response that DELETES the cart cookie must never be stored and replayed: a
	// cached copy would clear the next shopper's cart. The whole page is now
	// private (keepPrivate first — private-pages.test.ts), so the forgetting
	// render is covered without a conditional call of its own.
	test("it hands the order it read to forgetSpentCart, on a page already private", () => {
		const frontmatter = splitAstro(source("pages/orders/[orderId].astro")).frontmatter;
		expect(frontmatter).toMatch(/if \(order !== null\) \{\s*await forgetSpentCart\(/);
		expect(frontmatter.indexOf("keepPrivate(Astro);")).toBeGreaterThan(-1);
		expect(frontmatter.indexOf("keepPrivate(Astro);")).toBeLessThan(
			frontmatter.indexOf("await forgetSpentCart("),
		);
	});
});

describe("keepPrivate — a per-shopper response is never stored", () => {
	test("sets private, no-store and opts out of the route cache", () => {
		const headers = new Headers();
		const cacheCalls: unknown[] = [];
		keepPrivate({ response: { headers }, cache: { set: (options) => cacheCalls.push(options) } });
		expect(headers.get("Cache-Control")).toBe("private, no-store");
		expect(cacheCalls).toEqual([false]);
	});

	test("works where no route cache is configured", () => {
		const headers = new Headers();
		keepPrivate({ response: { headers } });
		expect(headers.get("Cache-Control")).toBe("private, no-store");
	});
});
