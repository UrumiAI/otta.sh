/**
 * Placing an order from /checkout, in a REAL browser.
 *
 * WHY A BROWSER. `test/checkout-place.test.ts` drives the place endpoint with a
 * hand-built `Origin`, so it could not see the bug this file was written for:
 * /checkout declared `referrer: no-referrer` (the coupon rides its URL), and
 * under that policy a browser sends `Origin: null` on the page's own form POST.
 * The site's CSRF guard reads "null" as cross-origin and 403s, so no order could
 * be placed while every unit test passed. It is the same bug #329 fixed on
 * /account/verify (see account-login.spec.ts). Only a browser decides what
 * `Origin` a form submission carries, so only a browser can pin it.
 *
 * WHAT IS ASSERTED. Only that the place POST reaches the plugin: it carries the
 * site's own origin and answers 303, not the guard's 403. Where the 303 goes
 * depends on the stack's payment configuration (a placeholder Stripe key lands
 * back on /checkout with PAYMENT_INTENT_FAILED; a real one on /checkout/pay),
 * and that is not this spec's subject.
 */
import { expect, skipWithoutSite, test } from "./harness.js";

test.describe("checkout in the browser", () => {
	test("the place form's own POST is same-origin: it reaches the plugin, not a 403", async ({
		page,
		baseURL,
	}, testInfo) => {
		await skipWithoutSite(testInfo);
		await page.route(/js\.stripe\.com/, (route) => route.abort());

		await page.goto("/products");
		const product = page.locator('a[href^="/products/"]').first();
		const hasProduct = await product.waitFor({ timeout: 5_000 }).then(
			() => true,
			() => false,
		);
		test.skip(!hasProduct, "the site has no products to buy");
		await product.click();
		await Promise.all([
			page.waitForResponse((res) => new URL(res.url()).pathname === "/cart/add"),
			page.locator('form[action="/cart/add"] button[type="submit"]').click(),
		]);
		await page.waitForLoadState("load");

		await page.goto("/checkout");
		const form = page.locator('form[action="/checkout/place"]');
		await form.locator('input[name="email"]').fill(`e2e-${Date.now()}@example.test`);
		await form.locator('input[name="name"]').fill("E2E Shopper");
		await form.locator('input[name="line1"]').fill("1 Test Street");
		await form.locator('input[name="city"]').fill("Springfield");
		await form.locator('input[name="postalCode"]').fill("12345");
		const country = form.locator('select[name="country"]');
		if ((await country.count()) > 0) await country.selectOption("US");
		const region = form.locator('input[name="region"]');
		if ((await region.count()) > 0 && (await region.isVisible())) await region.fill("CA");

		const [place] = await Promise.all([
			page.waitForResponse((res) => new URL(res.url()).pathname === "/checkout/place"),
			form.locator('button[type="submit"]').click(),
		]);

		// THE ASSERTIONS: the browser sent the real origin, and the guard let it through.
		const origin = await place.request().headerValue("origin");
		expect(origin, "the browser sent an opaque Origin on the place POST").toBe(
			new URL(baseURL ?? page.url()).origin,
		);
		expect(place.status(), "the place POST was refused as cross-origin").not.toBe(403);
		expect(place.status()).toBe(303);
	});
});
