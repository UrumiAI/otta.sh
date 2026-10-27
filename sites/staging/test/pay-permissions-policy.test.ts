/**
 * The pay page lets Stripe's frames ask for the Payment Request API (issue #108).
 *
 * EmDash's middleware stamps `Permissions-Policy: … payment=()` on every
 * response that has none, and `payment=()` keeps Apple Pay / Google Pay out of
 * the Payment Element. Its middleware is `order: "pre"` and finalizes the
 * response AFTER `next()` returns — so whatever this site's middleware sets is
 * already there when EmDash checks, and it leaves it alone. This suite pins:
 *  - `/checkout/pay` answers with the site's own policy: camera, microphone and
 *    geolocation still denied, payment allowed for self and Stripe.js's frames;
 *  - it is set on every answer the route gives — the plain render, the
 *    per-shopper (cookie) render, and a redirect with immutable headers;
 *  - every other route is untouched, so EmDash's baseline (`payment=()`)
 *    still applies there.
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(handler: T): T => handler,
}));

import { CART_COOKIE_NAME } from "@urumi.ai/otta-plugin";
import { PAY_PERMISSIONS_POLICY, onRequest } from "../src/middleware.js";
import { PRIVATE_NO_STORE } from "../src/lib/no-store.js";

const SITE = "http://localhost:4321";

type Handler = (ctx: unknown, next: () => Promise<Response>) => Promise<Response>;
const runMiddleware = onRequest as unknown as Handler;

function context(pathname: string, routePattern: string, cookies: Record<string, string> = {}) {
	const url = new URL(pathname, SITE);
	return {
		request: new Request(url, { method: "GET" }),
		url,
		routePattern,
		cookies: {
			get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined),
			set: vi.fn(),
			delete: vi.fn(),
		},
		locals: {},
		cache: { set: vi.fn() },
	};
}

const page = () =>
	Promise.resolve(
		new Response("<!doctype html>", { headers: { "Content-Type": "text/html; charset=utf-8" } }),
	);

/** EmDash's `finalizeResponse` rule for this header (emdash dist/astro/middleware.mjs). */
function emdashFinalize(response: Response): Response {
	const res = new Response(response.body, response);
	if (!res.headers.has("Permissions-Policy"))
		res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
	return res;
}

/** `directive=(allowlist)` pairs of a Permissions-Policy value. */
function directives(policy: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const part of policy.split(",")) {
		const [name, value] = part.trim().split("=");
		out.set(name ?? "", value ?? "");
	}
	return out;
}

describe("the pay page's Permissions-Policy (issue #108)", () => {
	test("allows payment for self and Stripe.js, and still denies camera, microphone, geolocation", () => {
		const policy = directives(PAY_PERMISSIONS_POLICY);
		expect(policy.get("payment")).toBe('(self "https://js.stripe.com" "https://*.js.stripe.com")');
		expect(policy.get("camera")).toBe("()");
		expect(policy.get("microphone")).toBe("()");
		expect(policy.get("geolocation")).toBe("()");
	});

	test("GET /checkout/pay carries it, and EmDash's finalize leaves it in place", async () => {
		const response = await runMiddleware(context("/checkout/pay", "/checkout/pay"), page);
		expect(response.headers.get("Permissions-Policy")).toBe(PAY_PERMISSIONS_POLICY);
		expect(emdashFinalize(response).headers.get("Permissions-Policy")).toBe(PAY_PERMISSIONS_POLICY);
	});

	test("a shopper with a cart gets it too, alongside the private no-store", async () => {
		const response = await runMiddleware(
			context("/checkout/pay", "/checkout/pay", { [CART_COOKIE_NAME]: "cart-1" }),
			page,
		);
		expect(response.headers.get("Permissions-Policy")).toBe(PAY_PERMISSIONS_POLICY);
		expect(response.headers.get("Cache-Control")).toBe(PRIVATE_NO_STORE);
	});

	test("a redirect from the page (immutable headers) still carries it", async () => {
		const response = await runMiddleware(context("/checkout/pay", "/checkout/pay"), () =>
			Promise.resolve(Response.redirect(`${SITE}/checkout`, 303)),
		);
		expect(response.status).toBe(303);
		expect(response.headers.get("Location")).toBe(`${SITE}/checkout`);
		expect(response.headers.get("Permissions-Policy")).toBe(PAY_PERMISSIONS_POLICY);
	});

	test.each([
		["/", "/"],
		["/cart", "/cart"],
		["/checkout", "/checkout"],
		["/orders/ord_1", "/orders/[orderId]"],
		["/_emdash/admin", "/_emdash/admin/[...path]"],
	])("%s is left to EmDash's baseline (payment=())", async (pathname, routePattern) => {
		const response = await runMiddleware(context(pathname, routePattern), page);
		expect(response.headers.has("Permissions-Policy")).toBe(false);
		expect(emdashFinalize(response).headers.get("Permissions-Policy")).toContain("payment=()");
	});
});
