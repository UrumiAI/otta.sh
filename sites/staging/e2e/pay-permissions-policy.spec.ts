/**
 * The pay page's `Permissions-Policy` (issue #108), against the REAL stack.
 *
 * `test/pay-permissions-policy.test.ts` pins the site middleware against a copy
 * of EmDash's finalize rule. This spec asks the running site instead, so an
 * EmDash upgrade that starts overwriting the header — and closes wallets off
 * again — fails here even though the unit tier stays green.
 */
import { expect, skipWithoutSite, test } from "./harness.js";

/** Kept in step with `PAY_PERMISSIONS_POLICY` in `src/middleware.ts`. */
const PAY_POLICY =
	'camera=(), microphone=(), geolocation=(), payment=(self "https://js.stripe.com" "https://*.js.stripe.com")';

test("/checkout/pay allows payment for Stripe; other pages keep payment=()", async ({
	page,
}, testInfo) => {
	await skipWithoutSite(testInfo);

	// With no checkout in flight the page answers with a redirect — the route,
	// not the render, decides the header, so that answer carries it too.
	const pay = await page.request.get("/checkout/pay", { maxRedirects: 0 });
	expect(pay.headers()["permissions-policy"]).toBe(PAY_POLICY);

	const home = await page.request.get("/", { maxRedirects: 0 });
	expect(home.headers()["permissions-policy"]).toMatch(/payment=\(\)/);
});
