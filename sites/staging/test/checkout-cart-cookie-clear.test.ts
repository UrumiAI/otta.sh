/**
 * #610 — `/checkout` drops a cart cookie the summary says names no cart, as the
 * cart's own write shims do (#447), so a tampered or expired cookie does not
 * keep landing the shopper back on the same refusal.
 *
 * ONLY `CART_NOT_FOUND` (or `INVALID_CART_ID`, should the summary ever give it).
 * Unlike on the cart's write routes, the summary's `INVALID_INPUT` is NOT a bad
 * cookie: the page also dispatches the URL's coupon, destination and method, so
 * a hand-edited `?coupon=` must never cost the shopper their cart.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckoutSummaryRouteResult } from "@urumi.ai/otta-plugin";
import { describe, expect, test } from "vitest";
import { checkoutDropsCartCookie } from "../src/lib/checkout-redirect.js";
import { splitAstro } from "./astro-source.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function refusal(token: { reason: string } | { error: string }): CheckoutSummaryRouteResult {
	return { ok: false, ...token } as CheckoutSummaryRouteResult;
}

describe("GET /checkout — which summary refusals drop the cart cookie", () => {
	test.each([[{ reason: "CART_NOT_FOUND" }], [{ error: "INVALID_CART_ID" }]])(
		"%o drops it: the cookie names no cart",
		(token) => {
			expect(checkoutDropsCartCookie(refusal(token))).toBe(true);
		},
	);

	test.each([
		[{ error: "INVALID_INPUT" }],
		[{ error: "RENDER_FAILED" }],
		[{ error: "BUSY" }],
		[{ reason: "CART_EMPTY" }],
		[{ reason: "CART_CHECKED_OUT" }],
		[{ reason: "CURRENCY_MISMATCH" }],
		[{ reason: "PRODUCT_NOT_PRICED" }],
	])("%o keeps it", (token) => {
		expect(checkoutDropsCartCookie(refusal(token))).toBe(false);
	});

	test("a dead dispatcher (null) keeps it: not knowing is not proof the cart is gone", () => {
		expect(checkoutDropsCartCookie(null)).toBe(false);
	});

	test("the checkout page deletes the cart cookie, at the cookie's own path, on that answer", () => {
		const { frontmatter } = splitAstro(
			readFileSync(path.resolve(HERE, "../src/pages/checkout/index.astro"), "utf8"),
		);
		expect(frontmatter).toMatch(
			/if \(checkoutDropsCartCookie\(result\)\)\s*\{?\s*Astro\.cookies\.delete\(CART_COOKIE_NAME, \{ path: CART_COOKIE_PATH \}\)/,
		);
		// …and before the redirect, or it never runs.
		expect(frontmatter.indexOf("checkoutDropsCartCookie(result)")).toBeLessThan(
			frontmatter.indexOf("checkoutEntryRedirect(cartId, result)"),
		);
	});
});
