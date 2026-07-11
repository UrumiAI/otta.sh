/**
 * Cart-cookie shim guard (reviewer-required): the plugin's cart routes
 * return a cookie DESCRIPTOR (they cannot set headers — ADR-0003 /
 * cart-routes.ts); the site endpoint owns the actual `Set-Cookie`. This
 * test pins that EVERY descriptor attribute is honored — httpOnly, secure,
 * sameSite, path, and the maxAgeSeconds→maxAge rename. A silently dropped
 * `httpOnly`/`secure` (session-hijackable / plaintext-leaked cart cookie)
 * must fail here, so the assertion is exact deep equality, not a subset
 * match.
 */
import type { CartCookieDescriptor } from "@urumi/plugin";
import { describe, expect, test } from "vitest";
import { applyCartCookie, type CookieJar } from "../src/lib/cart-cookie.js";

const descriptor: CartCookieDescriptor = {
	name: "urumi_cart",
	value: "cart-123",
	httpOnly: true,
	secure: true,
	sameSite: "lax",
	path: "/",
	maxAgeSeconds: 2_592_000,
};

describe("applyCartCookie", () => {
	test("sets the cookie with EVERY descriptor attribute honored (maxAgeSeconds→maxAge)", () => {
		const calls: { name: string; value: string; options: Record<string, unknown> }[] = [];
		const jar: CookieJar = {
			set(name, value, options) {
				calls.push({ name, value, options: { ...options } });
			},
		};

		applyCartCookie(jar, descriptor);

		expect(calls).toEqual([
			{
				name: "urumi_cart",
				value: "cart-123",
				// EXACT equality: an omitted attribute (e.g. a dropped
				// httpOnly or secure) fails this assertion.
				options: {
					httpOnly: true,
					secure: true,
					sameSite: "lax",
					path: "/",
					maxAge: 2_592_000,
				},
			},
		]);
	});
});
