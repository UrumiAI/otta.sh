/**
 * The plugin's `BUSY` answer (storage contention: nothing was written by the
 * refused step, safe to try again) at the site boundary.
 *
 *  - `dispatchOttaRoute` retries it ONCE, and only for an ALLOWLISTED call: a
 *    read route, or a keyed cart-line mutation whose replay the domain dedupes.
 *    Everything else — `cart/create`, `checkout/place`, the Stripe webhook, and
 *    any route added later — is never retried here.
 *  - A form POST that still ends BUSY answers 503 + a short `Retry-After` with
 *    friendly copy — never the generic "something went wrong" 303.
 *  - A GET page that ends BUSY is marked 503 + `Retry-After` by `markBusy`.
 */
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { APIContext } from "astro";

const { getEmDashEntry } = vi.hoisted(() => ({ getEmDashEntry: vi.fn() }));
vi.mock("emdash", () => ({ getEmDashEntry }));

vi.mock("../src/lib/stripe-config.js", () => ({
	STRIPE_PUBLIC_KEY_VAR: "STRIPE_PUBLIC_KEY",
	resolveStripePublishableKey: (raw: string | undefined) => raw,
	STRIPE_PUBLISHABLE_KEY: "pk_test_fake",
}));

import {
	STOREFRONT_ORDER_ABANDON_ROUTE,
	STOREFRONT_ORDER_RESUME_ROUTE,
	STOREFRONT_CART_CREATE_ROUTE,
	STOREFRONT_CART_LINE_ADD_ROUTE,
	STOREFRONT_CART_LINE_REMOVE_ROUTE,
	STOREFRONT_CART_LINE_UPDATE_ROUTE,
	STOREFRONT_CHECKOUT_PLACE_ROUTE,
	STOREFRONT_PRODUCT_ROUTE,
	STRIPE_WEBHOOK_SETTLE_ROUTE,
	ACCOUNT_LOGIN_REQUEST_ROUTE,
	ACCOUNT_LOGIN_VERIFY_ROUTE,
	ACCOUNT_LOGOUT_ROUTE,
	SESSION_COOKIE_NAME,
	type OrderRouteResult,
} from "@otta-sh/plugin";
import { seeOther } from "../src/lib/cart-actions.js";
import { checkoutEntryRedirect } from "../src/lib/checkout-redirect.js";
import { payPageRedirect } from "../src/lib/pay-guard.js";
import { cartErrorMessage } from "../src/lib/error-messages.js";
import {
	BUSY,
	BUSY_RETRY_AFTER_SECONDS,
	busyResponse,
	dispatchOttaRoute,
	isBusyResult,
	markBusy,
	safeReturnPath,
} from "../src/lib/otta-api.js";
import { POST as ADD_POST } from "../src/pages/cart/add.js";
import { POST as UPDATE_POST } from "../src/pages/cart/update.js";
import { POST as PLACE_POST } from "../src/pages/checkout/place.js";
import { POST as LOGIN_REQUEST_POST } from "../src/pages/account/login/request.js";
import { POST as LOGOUT_POST } from "../src/pages/account/logout.js";
import { POST as VERIFY_CONFIRM_POST } from "../src/pages/account/verify/confirm.js";

const SITE = "http://localhost:4321";
const BUSY_RESULT = { ok: false, error: "BUSY", retryable: true } as const;

interface Call {
	route: string;
	body: Record<string, unknown>;
}

/** A fake public dispatcher that answers each call from a per-route script;
 *  the LAST scripted answer repeats. */
function scripted(script: Record<string, unknown[]>): { handler: never; calls: Call[] } {
	const calls: Call[] = [];
	const seen: Record<string, number> = {};
	const handler = async (_id: string, _method: string, path: string, request: Request) => {
		const route = path.replace(/^\//, "");
		calls.push({ route, body: (await request.json()) as Record<string, unknown> });
		const answers = script[route];
		if (answers === undefined) return { success: false };
		const n = seen[route] ?? 0;
		seen[route] = n + 1;
		return { success: true, data: answers[Math.min(n, answers.length - 1)] };
	};
	return { handler: handler as never, calls };
}

function formContext(
	pathname: string,
	form: Record<string, string>,
	handler: unknown,
	{ cartCookie = "cart-1" }: { cartCookie?: string | null } = {},
): APIContext {
	const url = new URL(pathname, SITE);
	const request = new Request(url, {
		method: "POST",
		headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(form).toString(),
	});
	const cookies = new Map<string, string>(cartCookie === null ? [] : [["otta_cart", cartCookie]]);
	return {
		request,
		url,
		cookies: {
			get: (name: string) => {
				const value = cookies.get(name);
				return value === undefined ? undefined : { value };
			},
			set: (name: string, value: string) => cookies.set(name, value),
			delete: (name: string) => cookies.delete(name),
		},
		locals: { emdash: { handlePublicPluginApiRoute: handler } },
		redirect: (path: string, status = 302) =>
			new Response(null, { status, headers: { location: path } }),
	} as unknown as APIContext;
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	getEmDashEntry.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isBusyResult", () => {
	test("recognizes the plugin's BUSY envelope and nothing else", () => {
		expect(isBusyResult(BUSY_RESULT)).toBe(true);
		expect(isBusyResult({ ok: false, error: "RENDER_FAILED" })).toBe(false);
		expect(isBusyResult({ ok: true })).toBe(false);
		expect(isBusyResult(null)).toBe(false);
	});
});

describe("dispatchOttaRoute — one automatic retry, only when replay is safe", () => {
	test("a READ route that answers BUSY once is retried and the second answer wins", async () => {
		const ok = { ok: true, product: {}, jsonLd: {} };
		const { handler, calls } = scripted({ [STOREFRONT_PRODUCT_ROUTE]: [BUSY_RESULT, ok] });

		const result = await dispatchOttaRoute(handler, STOREFRONT_PRODUCT_ROUTE, {}, new URL(SITE));

		expect(result).toEqual(ok);
		expect(calls).toHaveLength(2);
	});

	test("storefront/order/resume is retried once with the SAME input — it replays the order's own key", async () => {
		// QA U-2: the resume replays the order's original checkout on its own
		// idempotency key, so a second call converges on the same order and intent.
		const ok = { ok: true, orderId: "o", clientAction: { kind: "none" }, buyerRefHint: "x" };
		const { handler, calls } = scripted({
			[STOREFRONT_ORDER_RESUME_ROUTE]: [BUSY_RESULT, ok],
		});
		const input = { orderId: "o", cartId: "c" };

		const result = await dispatchOttaRoute(
			handler,
			STOREFRONT_ORDER_RESUME_ROUTE,
			input,
			new URL(SITE),
		);

		expect(result).toEqual(ok);
		expect(calls.map((c) => c.body)).toEqual([input, input]);
	});

	test("storefront/order/abandon is retried once — its cancel runs on a key derived from the order (QA2 X4)", async () => {
		const ok = { ok: true, cancelled: true };
		const { handler, calls } = scripted({ [STOREFRONT_ORDER_ABANDON_ROUTE]: [BUSY_RESULT, ok] });
		const input = { cartId: "c" };

		const result = await dispatchOttaRoute(
			handler,
			STOREFRONT_ORDER_ABANDON_ROUTE,
			input,
			new URL(SITE),
		);

		expect(result).toEqual(ok);
		expect(calls.map((c) => c.body)).toEqual([input, input]);
	});

	test("a mutation carrying an idempotencyKey is retried with the SAME key", async () => {
		const ok = { ok: true, line: {} };
		const { handler, calls } = scripted({ [STOREFRONT_CART_LINE_ADD_ROUTE]: [BUSY_RESULT, ok] });

		const result = await dispatchOttaRoute(
			handler,
			STOREFRONT_CART_LINE_ADD_ROUTE,
			{ cartId: "c", sku: "S", qty: 1, idempotencyKey: "k-1" },
			new URL(SITE),
		);

		expect(result).toEqual(ok);
		expect(calls.map((c) => c.body["idempotencyKey"])).toEqual(["k-1", "k-1"]);
	});

	test("a key-less mutation (cart/create) is NEVER retried — a replay could mint a second cart", async () => {
		const { handler, calls } = scripted({ [STOREFRONT_CART_CREATE_ROUTE]: [BUSY_RESULT] });

		const result = await dispatchOttaRoute(
			handler,
			STOREFRONT_CART_CREATE_ROUTE,
			{},
			new URL(SITE),
		);

		expect(result).toEqual(BUSY_RESULT);
		expect(calls).toHaveLength(1);
	});

	test("checkout/place is NEVER auto-retried, even though it carries an idempotencyKey", async () => {
		// Its key is `checkout:<cartId>`, and a replay after a PARTIAL first attempt
		// can short-circuit to the existing order without finishing it. Until that
		// replay is proven whole, no automatic retry may depend on it.
		const { handler, calls } = scripted({
			[STOREFRONT_CHECKOUT_PLACE_ROUTE]: [BUSY_RESULT, { ok: true }],
		});

		const result = await dispatchOttaRoute(
			handler,
			STOREFRONT_CHECKOUT_PLACE_ROUTE,
			{ cartId: "cart-1", buyerRef: "a@example.com", idempotencyKey: "checkout:cart-1" },
			new URL(SITE),
		);

		expect(result).toEqual(BUSY_RESULT);
		expect(calls).toHaveLength(1);
	});

	test("the Stripe webhook route is NEVER auto-retried by the site — Stripe's redelivery is the retry", async () => {
		// Excluded by NAME, not by the accident of its busy shape using `reason`:
		// even a BUSY in the storefront shape must not be retried here.
		const { handler, calls } = scripted({
			[STRIPE_WEBHOOK_SETTLE_ROUTE]: [BUSY_RESULT, { ok: true, status: 200 }],
		});

		const result = await dispatchOttaRoute(
			handler,
			STRIPE_WEBHOOK_SETTLE_ROUTE,
			{ rawBodyBase64: "e30=", stripeSignature: "t=1", idempotencyKey: "stripe-webhook:x" },
			new URL(SITE),
		);

		expect(result).toEqual(BUSY_RESULT);
		expect(calls).toHaveLength(1);
	});

	test("cart/lines/remove (keyed) is on the allowlist and retried with the SAME key", async () => {
		const ok = { ok: true };
		const { handler, calls } = scripted({ [STOREFRONT_CART_LINE_REMOVE_ROUTE]: [BUSY_RESULT, ok] });

		const result = await dispatchOttaRoute(
			handler,
			STOREFRONT_CART_LINE_REMOVE_ROUTE,
			{ cartId: "c", lineId: "l", idempotencyKey: "k-rm" },
			new URL(SITE),
		);

		expect(result).toEqual(ok);
		expect(calls.map((c) => c.body["idempotencyKey"])).toEqual(["k-rm", "k-rm"]);
	});

	test("a keyed cart-line mutation WITHOUT its key is not retried — the key is what makes replay converge", async () => {
		const { handler, calls } = scripted({
			[STOREFRONT_CART_LINE_ADD_ROUTE]: [BUSY_RESULT, { ok: true }],
		});

		const result = await dispatchOttaRoute(
			handler,
			STOREFRONT_CART_LINE_ADD_ROUTE,
			{ cartId: "c", sku: "S", qty: 1 },
			new URL(SITE),
		);

		expect(result).toEqual(BUSY_RESULT);
		expect(calls).toHaveLength(1);
	});

	test("an UNKNOWN route carrying an idempotencyKey is NOT retried — the retry is an allowlist", async () => {
		// A future route defaults to no automatic retry until someone proves its
		// replay converges and adds it by name.
		const route = "storefront/some/future/mutation";
		const { handler, calls } = scripted({ [route]: [BUSY_RESULT, { ok: true }] });

		const result = await dispatchOttaRoute(
			handler,
			route,
			{ cartId: "c", idempotencyKey: "k-future" },
			new URL(SITE),
		);

		expect(result).toEqual(BUSY_RESULT);
		expect(calls).toHaveLength(1);
	});

	test("at most ONE retry: still busy ⇒ the BUSY result is returned to the caller", async () => {
		const { handler, calls } = scripted({ [STOREFRONT_PRODUCT_ROUTE]: [BUSY_RESULT] });

		const result = await dispatchOttaRoute(handler, STOREFRONT_PRODUCT_ROUTE, {}, new URL(SITE));

		expect(result).toEqual(BUSY_RESULT);
		expect(calls).toHaveLength(2);
	});
});

/** Plain-looking same-site paths that a URL parser RESOLVES to `//evil.com` —
 *  a protocol-relative, off-site target — through dot segments, literal or
 *  percent-encoded (WHATWG treats `%2e` / `%2E` as `.` in a path segment). */
const DOT_SEGMENT_VECTORS = [
	"/.//evil.com",
	"/..//evil.com",
	"/a/../..//evil.com",
	"/%2e%2e//evil.com",
	"/%2E%2E//evil.com",
	"/%2e//evil.com",
	"/a/%2e%2e/%2e%2e//evil.com",
	"/.%2e//evil.com",
];

describe("busy answers — 503 + Retry-After, friendly copy", () => {
	test("the Retry-After is short (2–5s)", () => {
		expect(BUSY_RETRY_AFTER_SECONDS).toBeGreaterThanOrEqual(2);
		expect(BUSY_RETRY_AFTER_SECONDS).toBeLessThanOrEqual(5);
	});

	test("BUSY has its own copy — not the generic fallback", () => {
		expect(cartErrorMessage(BUSY)).toMatch(/busy/i);
		expect(cartErrorMessage(BUSY)).not.toBe(cartErrorMessage("RENDER_FAILED"));
	});

	test("busyResponse is a 503 with Retry-After, no-store, the busy copy and a same-site way back", async () => {
		const response = busyResponse("/cart");

		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe(String(BUSY_RETRY_AFTER_SECONDS));
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = await response.text();
		expect(body).toContain(cartErrorMessage(BUSY));
		expect(body).toContain('href="/cart"');
	});

	test.each([
		"/\\evil.com",
		"\\\\evil.com",
		"//evil.com",
		"https://evil.com/x",
		"/\\/evil.com",
		...DOT_SEGMENT_VECTORS,
	])(
		"busyResponse never links off-site (%s) — the link falls back to a same-site path",
		async (backTo) => {
			const body = await busyResponse(backTo).text();
			const href = /href="([^"]*)"/.exec(body)?.[1];
			expect(href).toBeDefined();
			expect(href).toMatch(/^\/(?![/\\])/);
			expect(new URL(href!.replaceAll("&amp;", "&"), SITE).origin).toBe(SITE);
		},
	);

	test("busyResponse keeps a same-site path and its query", async () => {
		const body = await busyResponse("/products/mug?x=1&y=2").text();
		expect(body).toContain('href="/products/mug?x=1&amp;y=2"');
	});

	test("markBusy turns a page response into a 503 with Retry-After", () => {
		const page = { status: 200, headers: new Headers() };
		markBusy(page);
		expect(page.status).toBe(503);
		expect(page.headers.get("retry-after")).toBe(String(BUSY_RETRY_AFTER_SECONDS));
	});
});

describe("form endpoints that end BUSY answer 503, not the generic 303", () => {
	test("/cart/add: retried once with the same key, then 503 + Retry-After", async () => {
		const { handler, calls } = scripted({ [STOREFRONT_CART_LINE_ADD_ROUTE]: [BUSY_RESULT] });

		const response = await ADD_POST(
			formContext("/cart/add", { sku: "S", idempotencyKey: "k-add" }, handler),
		);

		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe(String(BUSY_RETRY_AFTER_SECONDS));
		expect(calls.filter((c) => c.route === STOREFRONT_CART_LINE_ADD_ROUTE)).toHaveLength(2);
	});

	test("/cart/add: a busy PRE-CHECK read (the PDP route) is a 503 too, not SERVICE_UNAVAILABLE", async () => {
		getEmDashEntry.mockResolvedValue({
			entry: { data: { id: "p1", slug: "p", title: "P" } },
			error: undefined,
		});
		const { handler, calls } = scripted({ [STOREFRONT_PRODUCT_ROUTE]: [BUSY_RESULT] });

		const response = await ADD_POST(
			formContext("/cart/add", { sku: "S", productId: "p1", idempotencyKey: "k" }, handler),
		);

		expect(response.status).toBe(503);
		expect(calls.some((c) => c.route === STOREFRONT_CART_LINE_ADD_ROUTE)).toBe(false);
	});

	test("/cart/add with no cart yet: a busy cart/create is a 503 (not retried), not SERVICE_UNAVAILABLE", async () => {
		const { handler, calls } = scripted({ [STOREFRONT_CART_CREATE_ROUTE]: [BUSY_RESULT] });

		const response = await ADD_POST(
			formContext(
				"/cart/add",
				{ sku: "S", idempotencyKey: "k", returnTo: "/products/mug" },
				handler,
				{ cartCookie: null },
			),
		);

		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe(String(BUSY_RETRY_AFTER_SECONDS));
		expect(await response.text()).toContain('href="/products/mug"');
		// Key-less: one call, never a second cart.
		expect(calls.filter((c) => c.route === STOREFRONT_CART_CREATE_ROUTE)).toHaveLength(1);
		expect(calls.some((c) => c.route === STOREFRONT_CART_LINE_ADD_ROUTE)).toBe(false);
	});

	test("/cart/add with no cart yet: a FAILED cart/create is still the 303 SERVICE_UNAVAILABLE", async () => {
		const { handler } = scripted({});

		const response = await ADD_POST(
			formContext("/cart/add", { sku: "S", idempotencyKey: "k" }, handler, { cartCookie: null }),
		);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/products?error=SERVICE_UNAVAILABLE");
	});

	test("/cart/update: 503 + Retry-After", async () => {
		const { handler } = scripted({ [STOREFRONT_CART_LINE_UPDATE_ROUTE]: [BUSY_RESULT] });

		const response = await UPDATE_POST(
			formContext("/cart/update", { lineId: "l", qty: "2", idempotencyKey: "k" }, handler),
		);

		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe(String(BUSY_RETRY_AFTER_SECONDS));
	});

	test("/checkout/place: 503 + Retry-After, and a non-busy failure still 303s", async () => {
		const form = { email: "a@example.com", idempotencyKey: "checkout:cart-1" };
		const busy = scripted({ [STOREFRONT_CHECKOUT_PLACE_ROUTE]: [BUSY_RESULT] });
		const response = await PLACE_POST(formContext("/checkout/place", form, busy.handler));
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe(String(BUSY_RETRY_AFTER_SECONDS));
		// NOT auto-retried: see the checkout/place case in the dispatch group.
		expect(busy.calls).toHaveLength(1);

		const failed = scripted({
			[STOREFRONT_CHECKOUT_PLACE_ROUTE]: [{ ok: false, error: "RENDER_FAILED" }],
		});
		const other = await PLACE_POST(formContext("/checkout/place", form, failed.handler));
		expect(other.status).toBe(303);
		expect(failed.calls).toHaveLength(1);
	});
});

describe("account form endpoints (#329) that end BUSY answer 503, not SERVICE_UNAVAILABLE", () => {
	test("/account/login/request: a busy login-link request is a 503 (not retried)", async () => {
		const { handler, calls } = scripted({ [ACCOUNT_LOGIN_REQUEST_ROUTE]: [BUSY_RESULT] });
		const response = await LOGIN_REQUEST_POST(
			formContext("/account/login/request", { email: "a@example.com" }, handler),
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe(String(BUSY_RETRY_AFTER_SECONDS));
		expect(calls).toHaveLength(1);
	});

	test("/account/verify/confirm: a busy verify is a 503 — nothing was consumed, so the emailed link still works", async () => {
		const { handler, calls } = scripted({ [ACCOUNT_LOGIN_VERIFY_ROUTE]: [BUSY_RESULT] });
		const response = await VERIFY_CONFIRM_POST(
			formContext("/account/verify/confirm", { challenge: "c-1", token: "t-1" }, handler),
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe(String(BUSY_RETRY_AFTER_SECONDS));
		// The busy page's way back never carries the one-time token.
		expect(await response.text()).not.toContain("t-1");
		expect(calls).toHaveLength(1);
	});

	test("/account/logout: a busy revoke still signs the browser out and says so in the log", async () => {
		const { handler } = scripted({ [ACCOUNT_LOGOUT_ROUTE]: [BUSY_RESULT] });
		const context = formContext("/account/logout", {}, handler);
		context.cookies.set(SESSION_COOKIE_NAME, "s-1");
		const response = await LOGOUT_POST(context);
		expect(response.status).toBe(303);
		expect(console.error).toHaveBeenCalled();
	});
});

describe("safeReturnPath — the returnTo guard", () => {
	test.each([
		"/\\evil.com",
		"/\\/evil.com",
		"\\evil.com",
		"//evil.com",
		"https://evil.com",
		"/ok\\x",
	])("%s is refused (a browser resolves a backslash like a slash)", (raw) => {
		expect(safeReturnPath(raw, "/products")).toBe("/products");
	});

	test.each(DOT_SEGMENT_VECTORS)(
		"%s is refused — it RESOLVES to the protocol-relative //evil.com",
		(raw) => {
			expect(safeReturnPath(raw, "/products")).toBe("/products");
		},
	);

	test("a harmless dot-segment path is returned NORMALIZED, never raw", () => {
		expect(safeReturnPath("/products/../cart?x=1", "/products")).toBe("/cart?x=1");
		expect(safeReturnPath("/./products/mug", "/products")).toBe("/products/mug");
	});

	test("an ordinary same-site path survives, query included", () => {
		expect(safeReturnPath("/products/mug?x=1", "/products")).toBe("/products/mug?x=1");
	});
});

describe("seeOther — the redirect itself never leaves the site", () => {
	test.each(["//evil.com", "/\\evil.com", ...DOT_SEGMENT_VECTORS])(
		"seeOther(%s) emits a same-site Location",
		(target) => {
			const context = formContext("/cart/add", {}, undefined);
			const response = seeOther(context, target, "SERVICE_UNAVAILABLE");
			const location = response.headers.get("location");
			expect(location).not.toBeNull();
			expect(location).toMatch(/^\/(?![/\\])/);
			expect(new URL(location!, SITE).origin).toBe(SITE);
		},
	);

	test.each(DOT_SEGMENT_VECTORS)(
		"/cart/add with returnTo=%s redirects to the fallback, not off-site",
		async (returnTo) => {
			const { handler } = scripted({
				[STOREFRONT_CART_LINE_ADD_ROUTE]: [{ ok: false, error: "RENDER_FAILED" }],
			});
			const response = await ADD_POST(
				formContext("/cart/add", { sku: "S", idempotencyKey: "k", returnTo }, handler),
			);
			expect(response.status).toBe(303);
			expect(response.headers.get("location")).toBe("/products?error=RENDER_FAILED");
		},
	);
});

describe("GET /checkout's entry guard", () => {
	test("a BUSY summary sends the buyer to /cart carrying the BUSY token (its own copy there)", () => {
		expect(checkoutEntryRedirect("cart-1", BUSY_RESULT)).toEqual({ path: "/cart", error: BUSY });
	});
});

describe("every SSR page that dispatches a plugin route maps BUSY to 503 + Retry-After", () => {
	const PAGES = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../src/pages");
	/** `/checkout` is the one documented exception: a BUSY summary 303s to /cart
	 *  (see `checkoutEntryRedirect` and the note in `checkout/index.astro`). */
	const REDIRECTS_INSTEAD = new Set(["checkout/index.astro"]);
	/** `/checkout/pay` FAILS OPEN on purpose: its one dispatch is a defence-in-depth
	 *  read of the stashed order (`lib/pay-guard.ts`, ADR-0012's 2026-10-02
	 *  amendment), and an UNKNOWN answer — BUSY included — renders the card form
	 *  rather than a 503. The server holds the line on its own: expiry withdraws the
	 *  PaymentIntent at Stripe and a payment that lands on a dead order is refunded
	 *  automatically, so a storage hiccup must not become a checkout outage. The
	 *  positive pins below keep the exemption from hiding a regression. */
	const FAILS_OPEN = new Set(["checkout/pay.astro"]);
	const pages = (readdirSync(PAGES, { recursive: true }) as string[])
		.filter((file) => file.endsWith(".astro"))
		.map((file) => file.split(nodePath.sep).join("/"))
		.filter((file) =>
			/dispatchOttaRoute\s*[<(]/.test(readFileSync(nodePath.join(PAGES, file), "utf8")),
		);

	test("the sweep finds the dispatching pages, home included", () => {
		expect(pages).toEqual(expect.arrayContaining(["index.astro", "products/index.astro"]));
	});

	test.each(pages.filter((file) => !REDIRECTS_INSTEAD.has(file) && !FAILS_OPEN.has(file)))(
		"%s calls markBusy",
		(file) => {
			const source = readFileSync(nodePath.join(PAGES, file), "utf8");
			expect(source).toMatch(/isBusyResult\(result\)/);
			expect(source).toMatch(/markBusy\(Astro\.response\)/);
		},
	);

	test("checkout/pay.astro is the fail-open exemption: still a dispatching page, and it 303s a known non-payable answer", () => {
		expect(pages).toContain("checkout/pay.astro");
		const source = readFileSync(nodePath.join(PAGES, "checkout/pay.astro"), "utf8");
		// Its one read goes through the guard, and the guard's verdict is a 303.
		expect(source).toMatch(/payPageRedirect\(orderPath, orderRead, new Date\(\)\)/);
		expect(source).toMatch(/return Astro\.redirect\(refuseTo, 303\)/);
		// Failing open never means failing cacheable: the page renders a client
		// secret, so it is private (fix/private-pages-no-store) BEFORE its order read.
		const keep = source.indexOf("keepPrivate(Astro)");
		expect(keep, "pay.astro calls keepPrivate(Astro)").toBeGreaterThan(-1);
		expect(keep, "keepPrivate precedes the order read").toBeLessThan(
			source.indexOf("dispatchOttaRoute<OrderRouteResult>("),
		);
	});

	test("the pay guard renders on BUSY and refuses a known non-payable order", () => {
		const orderPath = "/orders/ord-1";
		const now = new Date("2026-10-02T12:00:00.000Z");
		// BUSY is an unknown answer: the form renders (null), never a 503 or a refusal.
		expect(payPageRedirect(orderPath, BUSY_RESULT as unknown as OrderRouteResult, now)).toBeNull();
		// A definitive answer that cannot take the money goes to the order page.
		const expired = {
			ok: true,
			order: { state: "expired", holdExpiresAt: "2026-10-02T12:15:00.000Z" },
		} as unknown as OrderRouteResult;
		expect(payPageRedirect(orderPath, expired, now)).toBe(orderPath);
		const lapsed = {
			ok: true,
			order: { state: "pending", holdExpiresAt: "2026-10-02T11:59:59.000Z" },
		} as unknown as OrderRouteResult;
		expect(payPageRedirect(orderPath, lapsed, now)).toBe(orderPath);
	});

	test("checkout/index.astro documents its BUSY redirect as intentional", () => {
		const source = readFileSync(nodePath.join(PAGES, "checkout/index.astro"), "utf8");
		expect(source).toMatch(/BUSY/);
	});
});
