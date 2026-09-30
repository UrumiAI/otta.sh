/**
 * The chrome's bag (`lib/bag.ts`) — the one cart read a theme whose chrome
 * draws the cart's lines opts into — the forms it posts to `/cart/update` and
 * `/cart/remove`, and the caching rule for a page that drew it.
 *
 * The contract under test is FAIL SOFT: the bag decorates a page with its own
 * job, so no answer from the cart read — BUSY, a failure, a throw, a gone cart
 * — may turn that page into an error or a 503. And a page that drew one
 * shopper's bag is that shopper's: never shared-cached.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { APIContext } from "astro";

const { getEmDashCollection } = vi.hoisted(() => ({ getEmDashCollection: vi.fn() }));
vi.mock("emdash", () => ({ getEmDashCollection }));
vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(handler: T): T => handler,
}));

import {
	STOREFRONT_CART_LINE_REMOVE_ROUTE,
	STOREFRONT_CART_LINE_UPDATE_ROUTE,
	STOREFRONT_CART_READ_ROUTE,
} from "@otta-sh/plugin";
import { bagHold, readBag, wallClock } from "../src/lib/bag.js";
import { PRICED_AT_CHECKOUT_CELL } from "../src/lib/cart-view.js";
import { onRequest, PER_SHOPPER_NO_STORE } from "../src/middleware.js";
import { POST as REMOVE_POST } from "../src/pages/cart/remove.js";
import { POST as UPDATE_POST } from "../src/pages/cart/update.js";
import { themeFor } from "../src/themes/registry.js";
import { STORE_THEMES } from "../src/themes/manifest.js";
import { SRC } from "./theme-views.js";

const SITE = "http://localhost:4321";
const BUSY_RESULT = { ok: false, error: "BUSY", retryable: true } as const;

interface Call {
	route: string;
	body: Record<string, unknown>;
}

function scripted(script: Record<string, unknown[]>): { handler: never; calls: Call[] } {
	const calls: Call[] = [];
	const seen: Record<string, number> = {};
	const handler = async (_id: string, _method: string, route: string, request: Request) => {
		const name = route.replace(/^\//, "");
		calls.push({ route: name, body: (await request.json()) as Record<string, unknown> });
		const answers = script[name];
		if (answers === undefined) return { success: false };
		const n = seen[name] ?? 0;
		seen[name] = n + 1;
		return { success: true, data: answers[Math.min(n, answers.length - 1)] };
	};
	return { handler: handler as never, calls };
}

function bagRequest(handler: unknown, { cookie = "cart-1", url = "/products" } = {}) {
	return {
		cookies: {
			get: (name: string) =>
				name === "otta_cart" && cookie !== "" ? { value: cookie } : undefined,
		},
		locals: { emdash: { handlePublicPluginApiRoute: handler } } as never,
		url: new URL(url, SITE),
	};
}

const IN_TEN = new Date(Date.now() + 10 * 60_000).toISOString();

function cartResult(state = "active") {
	return {
		ok: true,
		cart: {
			cartId: "cart-1",
			state,
			orderId: null,
			currency: "USD",
			lines: [
				{
					lineId: "l-1",
					sku: "MUG",
					productId: "p-mug",
					qty: 2,
					reservationId: "r",
					expiresAt: IN_TEN,
				},
				{
					lineId: "l-2",
					sku: "TEE",
					productId: null,
					qty: 1,
					reservationId: null,
					expiresAt: null,
				},
			],
		},
		pricing: {
			degraded: false,
			lines: [
				{
					lineId: "l-1",
					unitPrice: { amount: 1800, currency: "USD", formatted: "$18.00" },
					lineTotal: { amount: 3600, currency: "USD", formatted: "$36.00" },
				},
				{ lineId: "l-2", unitPrice: null, lineTotal: null },
			],
			total: { amount: 3600, currency: "USD", formatted: "$36.00" },
			allLinesPriced: false,
		},
	};
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	getEmDashCollection.mockReset();
	getEmDashCollection.mockResolvedValue({
		entries: [{ data: { id: "p-mug", title: "Otta Mug", slug: "otta-mug", images: null } }],
	});
});
afterEach(() => vi.restoreAllMocks());

describe("readBag — one guarded cart read, and it fails soft", () => {
	test("no cart cookie: an empty bag, and nothing is dispatched", async () => {
		const { handler, calls } = scripted({});
		const bag = await readBag(bagRequest(handler, { cookie: "" }));
		expect(bag).toMatchObject({ state: "empty", count: 0, lines: [] });
		expect(calls).toHaveLength(0);
		expect(getEmDashCollection).not.toHaveBeenCalled();
	});

	test("BUSY is an unreadable bag — never a throw, never a 503 (it has no response to mark)", async () => {
		const { handler, calls } = scripted({ [STOREFRONT_CART_READ_ROUTE]: [BUSY_RESULT] });
		const bag = await readBag(bagRequest(handler));
		expect(bag).toMatchObject({ state: "unreadable", count: null, lines: [] });
		// ONE read: the bag opts out of the dispatcher's BUSY retry, so a
		// contended cart costs the page neither the pause nor a second read.
		expect(calls.map((call) => call.route)).toEqual([STOREFRONT_CART_READ_ROUTE]);
	});

	test("a failed read (or no dispatcher at all) is unreadable, not an error page", async () => {
		const failed = scripted({
			[STOREFRONT_CART_READ_ROUTE]: [{ ok: false, error: "RENDER_FAILED" }],
		});
		expect((await readBag(bagRequest(failed.handler))).state).toBe("unreadable");
		expect((await readBag(bagRequest(undefined))).state).toBe("unreadable");
	});

	test("a cart that no longer exists is an empty bag", async () => {
		const { handler } = scripted({
			[STOREFRONT_CART_READ_ROUTE]: [{ ok: false, reason: "CART_NOT_FOUND" }],
		});
		expect((await readBag(bagRequest(handler))).state).toBe("empty");
	});

	test("a checked-out cart draws no lines (issue #110: they are the order's now)", async () => {
		const { handler } = scripted({ [STOREFRONT_CART_READ_ROUTE]: [cartResult("checked_out")] });
		const bag = await readBag(bagRequest(handler));
		expect(bag).toMatchObject({ state: "checkedOut", count: null, lines: [] });
	});

	test("a live cart: units, names (SKU when unnamed), honest money, static holds, fresh keys", async () => {
		const { handler, calls } = scripted({ [STOREFRONT_CART_READ_ROUTE]: [cartResult()] });
		const bag = await readBag(bagRequest(handler));
		expect(calls).toEqual([{ route: STOREFRONT_CART_READ_ROUTE, body: { cartId: "cart-1" } }]);
		expect(bag.state).toBe("lines");
		expect(bag.count).toBe(3);
		expect(bag.subtotal).toBe("$36.00");
		// One line has no figure, so the subtotal is short of it and says so.
		expect(bag.partial).toBe(true);
		const [mug, tee] = bag.lines;
		expect(mug).toMatchObject({
			lineId: "l-1",
			name: "Otta Mug",
			title: "Otta Mug",
			money: "$36.00",
		});
		expect(mug?.hold?.state).toBe("held");
		expect(mug?.hold?.text).toMatch(/^Held for you until \d{1,2}:\d\d [ap]m UTC$/);
		expect(tee).toMatchObject({
			name: "TEE",
			title: null,
			money: PRICED_AT_CHECKOUT_CELL,
			hold: null,
		});
		const keys = bag.lines.flatMap((line) => [line.updateKey, line.removeKey]);
		expect(new Set(keys).size).toBe(4);
		// ONE batched content read, the cart page's pattern.
		expect(getEmDashCollection).toHaveBeenCalledTimes(1);
		expect(getEmDashCollection).toHaveBeenCalledWith("products", {
			where: { id: ["p-mug"] },
			limit: 50,
		});
	});

	test("a content read that fails leaves the SKU standing, never an error", async () => {
		getEmDashCollection.mockRejectedValue(new Error("d1 down"));
		const { handler } = scripted({ [STOREFRONT_CART_READ_ROUTE]: [cartResult()] });
		const bag = await readBag(bagRequest(handler));
		expect(bag.state).toBe("lines");
		expect(bag.lines[0]?.name).toBe("MUG");
	});
});

describe("the bag's hold copy is static wall-clock time", () => {
	test("wallClock floors to the minute and names UTC", () => {
		expect(wallClock("2026-09-30T16:52:59.900Z")).toBe("4:52 pm UTC");
		expect(wallClock("2026-09-30T00:05:00Z")).toBe("12:05 am UTC");
		expect(wallClock("2026-09-30T12:00:00Z")).toBe("12:00 pm UTC");
		expect(wallClock("nope")).toBeNull();
	});

	test("held / expiring / released / none", () => {
		const now = new Date("2026-09-30T16:40:00Z");
		expect(bagHold("2026-09-30T16:52:00Z", now)).toEqual({
			state: "held",
			text: "Held for you until 4:52 pm UTC",
		});
		expect(bagHold("2026-09-30T16:40:30Z", now)).toEqual({
			state: "expiring",
			text: "Held until 4:40 pm UTC. Check out to keep it.",
		});
		expect(bagHold("2026-09-30T16:30:00Z", now)).toEqual({
			state: "released",
			text: "Hold released",
		});
		expect(bagHold(null, now)).toBeNull();
	});
});

describe("only a theme that draws the bag pays for the read", () => {
	test.each(STORE_THEMES.map((theme) => theme.id))("%s", (id) => {
		// No theme opts in yet: the first theme whose chrome draws the lines
		// (Counter's bag drawer) turns it on in its own change.
		expect(themeFor(id).chrome?.cartLines === true).toBe(false);
	});

	test("the read lives in lib/bag.ts, which never marks a response BUSY", () => {
		const source = readFileSync(path.join(SRC, "lib/bag.ts"), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "");
		expect(source).toContain("dispatchOttaRouteOnce<CartReadRouteResult>(");
		expect(source).not.toMatch(/dispatchOttaRoute</);
		expect(source).not.toMatch(/markBusy|busyResponse|Astro\.response/);
	});
});

function formContext(pathname: string, form: Record<string, string>, handler: unknown): APIContext {
	const url = new URL(pathname, SITE);
	const request = new Request(url, {
		method: "POST",
		headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(form).toString(),
	});
	return {
		request,
		url,
		cookies: {
			get: (name: string) => (name === "otta_cart" ? { value: "cart-1" } : undefined),
			set: () => {},
			delete: () => {},
		},
		locals: { emdash: { handlePublicPluginApiRoute: handler } },
		redirect: (location: string, status = 302) =>
			new Response(null, { status, headers: { location } }),
	} as unknown as APIContext;
}

describe.each([
	["/cart/update", UPDATE_POST, STOREFRONT_CART_LINE_UPDATE_ROUTE, { qty: "2" }],
	["/cart/remove", REMOVE_POST, STOREFRONT_CART_LINE_REMOVE_ROUTE, {}],
] as const)("%s — the bag's forms land on /cart", (pathname, post, route, extra) => {
	test("a success lands on /cart, where the change is visible — a posted returnTo is ignored", async () => {
		const ok = scripted({ [route]: [{ ok: true, line: {} }] }).handler;
		const form = { lineId: "l-1", idempotencyKey: "k-1", ...extra, returnTo: "/products/otta-mug" };
		const response = await post(formContext(pathname, form, ok));
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/cart");
	});
});

// ── a page that drew a bag is per-shopper ─────────────────────────────────────

type Handler = (ctx: unknown, next: () => Promise<Response>) => Promise<Response>;
const runMiddleware = onRequest as unknown as Handler;
const htmlPage = (): Promise<Response> =>
	Promise.resolve(
		new Response("<html></html>", {
			headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=60" },
		}),
	);

function middlewareContext(route: string, cartCookie: string | null) {
	const url = new URL(route, SITE);
	return {
		request: new Request(url),
		url,
		cookies: {
			get: (name: string) =>
				name === "otta_cart" && cartCookie !== null ? { value: cartCookie } : undefined,
			set: vi.fn(),
			delete: vi.fn(),
		},
		locals: {},
		cache: { set: vi.fn() },
	};
}

describe("the middleware: a page that drew a bag is never shared-cached", () => {
	// Each shipped theme, picked with the dev `?theme=` override.
	test.each(STORE_THEMES.map((theme) => theme.id))("%s, with a cart cookie", async (id) => {
		const ctx = middlewareContext(`/products?theme=${id}`, "cart-1");
		const response = await runMiddleware(ctx, htmlPage);
		const drawsBag = themeFor(id).chrome?.cartLines === true;
		expect(response.headers.get("Cache-Control")).toBe(
			drawsBag ? PER_SHOPPER_NO_STORE : "public, max-age=60",
		);
		// Before the page and again after it (a page's own hint re-enables the cache).
		expect(ctx.cache.set.mock.calls).toEqual(drawsBag ? [[false], [false]] : []);
	});

	test.each(STORE_THEMES.map((theme) => theme.id))(
		"%s, with no cart cookie: the page's caching is untouched",
		async (id) => {
			const ctx = middlewareContext(`/products?theme=${id}`, null);
			const response = await runMiddleware(ctx, htmlPage);
			expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
			expect(ctx.cache.set).not.toHaveBeenCalled();
		},
	);
});
