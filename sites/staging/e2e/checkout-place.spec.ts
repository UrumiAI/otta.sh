/**
 * Placing an order from /checkout, in a REAL browser.
 *
 * WHY A BROWSER. `test/checkout-place.test.ts` drives the place endpoint with a
 * hand-built `Origin`, so it could not see the bug this file was written for:
 * /checkout declared `referrer: no-referrer` (the coupon rides its URL), and
 * under that policy browsers send `Origin: null` on the page's own form POST
 * (Fetch's "append a request `Origin` header"). The site's CSRF guard reads
 * "null" as cross-origin and 403s, so no order could be placed while every unit
 * test passed. It is the same bug #329 fixed on /account/verify (see
 * account-login.spec.ts). Only a browser decides what `Origin` and `Referer` a
 * form submission carries, and what `document.referrer` the redirect target
 * sees, so only a browser can pin them.
 *
 * WHAT IS ASSERTED.
 *  - The place POST carries the site's own origin (and, if it sends a Referer,
 *    a same-origin one) and answers 303, not the guard's 403.
 *  - The page that 303 lands on does not hold the coupon in `document.referrer`.
 *    Under `same-origin` the POST's Referer is the full /checkout?coupon=… URL,
 *    and a redirect keeps it unless the response says otherwise; place.ts's
 *    responses send `Referrer-Policy: no-referrer`. The coupon used is made up:
 *    a refused code still stays in the review's URL, which is all this needs.
 * Where the 303 goes depends on the stack's payment configuration, and that is
 * not this spec's subject: with no Stripe gateway configured in the plugin it
 * lands back on /checkout with RENDER_FAILED; with a placeholder secret key,
 * PAYMENT_INTENT_FAILED; with a real one, /checkout/pay.
 *
 * IT WRITES. Each run adds a product to a new cart and, on a stack with a
 * Stripe gateway configured, places a REAL order, which holds that product's
 * stock for the order hold window (15 minutes) until it is paid or swept. Point
 * it only at a local stack.
 */
import {
	expect,
	skipWithoutPlaceButton,
	skipWithoutPurchasableProduct,
	skipWithoutSite,
	test,
} from "./harness.js";

/** Not a real coupon: refused, but kept in the review's URL. */
const COUPON = "E2E-REFERRER-PROBE";

/** How many product pages to try before giving up on finding one to buy. */
const MAX_PRODUCTS_TRIED = 12;

test.describe("checkout in the browser", () => {
	test("the place form's own POST is same-origin: it reaches the plugin, not a 403", async ({
		page,
		baseURL,
	}, testInfo) => {
		await skipWithoutSite(testInfo);
		await page.route(/js\.stripe\.com/, (route) => route.abort());
		const siteOrigin = new URL(baseURL ?? page.url()).origin;

		// A product whose page actually offers add-to-cart (priced, in stock).
		await page.goto("/products");
		const productLinks = page.locator('a[href^="/products/"]');
		// Waited for, and the read retried: a cold dev server can reload the
		// page while it optimizes dependencies, which destroys a read mid-flight.
		await productLinks
			.first()
			.waitFor({ timeout: 10_000 })
			.catch(() => undefined);
		let hrefs: string[] = [];
		await expect(async () => {
			const all = await productLinks.evaluateAll((links) =>
				links.map((link) => link.getAttribute("href") ?? ""),
			);
			hrefs = [...new Set(all)].filter((href) => /^\/products\/[^/?#]+$/.test(href));
		}).toPass({ timeout: 10_000 });
		const addToCart = page.locator('form[action="/cart/add"] button[type="submit"]');
		let purchasable = false;
		for (const href of hrefs.slice(0, MAX_PRODUCTS_TRIED)) {
			await page.goto(href);
			if ((await addToCart.count()) > 0 && (await addToCart.first().isEnabled())) {
				purchasable = true;
				break;
			}
		}
		// An empty catalogue lands here too: the fix is the same seed.
		if (!purchasable) await skipWithoutPurchasableProduct(testInfo);
		await Promise.all([
			page.waitForResponse((res) => new URL(res.url()).pathname === "/cart/add"),
			addToCart.first().click(),
		]);
		await page.waitForLoadState("load");

		await page.goto("/checkout");

		// A store with zones asks where the order goes first (ADR-0021): choose a
		// country, then the first enabled delivery option, so the review is
		// ready to place.
		// The delivery block's fields and Update button belong to the place form
		// (QA U-1), under their own names.
		const delivery = page.locator("#delivery");
		if ((await delivery.count()) > 0) {
			const deliveryCountry = delivery.locator('select[name="deliveryCountry"]');
			if ((await deliveryCountry.inputValue()) === "") {
				await deliveryCountry.selectOption("US");
				await Promise.all([
					page.waitForURL(/\/checkout\?/),
					delivery.locator('button[value="update-delivery"]').click(),
				]);
			}
			const method = delivery.locator('input[name="deliveryMethod"]:not([disabled])').first();
			if ((await method.count()) > 0 && !(await method.isChecked())) {
				await method.check();
				await Promise.all([
					page.waitForURL(/method=/),
					delivery.locator('button[value="update-delivery"]').click(),
				]);
			}
		}

		// The coupon last: the delivery form echoes only a coupon the plugin
		// accepted, and this one is made up.
		const reviewUrl = new URL(page.url());
		reviewUrl.searchParams.set("coupon", COUPON);
		await page.goto(reviewUrl.pathname + reviewUrl.search);
		expect(page.url(), "the review dropped the coupon from its URL").toContain(COUPON);

		const form = page.locator('form[action="/checkout/place"]');
		// The visible "Continue to payment" — not the hidden Enter button, which
		// sits outside the form element (form= attribute) anyway.
		const submit = form.locator('button[type="submit"]');
		if ((await submit.count()) === 0) {
			const why = (await form.textContent())?.replace(/\s+/g, " ").trim() ?? "(no place form)";
			await skipWithoutPlaceButton(testInfo, why.slice(-240));
		}

		await form.locator('input[name="email"]').fill(`e2e-${Date.now()}@example.test`);
		const typed: Array<[string, string]> = [
			["name", "E2E Shopper"],
			["line1", "1 Test Street"],
			["city", "Springfield"],
			["postalCode", "12345"],
		];
		for (const [name, value] of typed) {
			const field = form.locator(`input[name="${name}"]`);
			if ((await field.count()) > 0 && (await field.isVisible())) await field.fill(value);
		}
		// Only where the buyer types them: on a zoned store they are the hidden
		// destination the review priced.
		// The state/province is a pick list rendered for the page's country (no
		// client JS): a newly chosen country's list arrives with Update, which
		// keeps everything typed.
		const country = form.locator('select[name="country"]');
		if ((await country.count()) > 0 && (await country.isVisible())) {
			await country.selectOption("US");
			// With JS (the default here) the optional script swaps the list in place
			// and hides Update (ADR-0034); without it, Update re-renders the page. A
			// REAL wait either way: the US state list must appear, or this fails.
			const update = form.locator('button[value="update-address"]');
			if (await update.isVisible()) {
				await Promise.all([
					page.waitForResponse(
						(res) =>
							new URL(res.url()).pathname === "/checkout/place" &&
							res.request().method() === "POST",
					),
					update.click(),
				]);
				await page.waitForLoadState("load");
			}
			await expect(form.locator('select[name="region"] option[value="CA"]')).toHaveCount(1);
			await expect(form.locator('input[name="email"]')).not.toHaveValue("");
		}
		const region = form.locator('select[name="region"]');
		if ((await region.count()) > 0 && (await region.isVisible())) await region.selectOption("CA");

		const before = page.url();
		// Placed by pressing ENTER in the email field, not by clicking: the place
		// form's default button is the hidden intent=enter submit (review round 1),
		// never Apply. The made-up coupon is refused and echoed as refusedCoupon,
		// so this Enter places rather than re-applying it.
		const [place] = await Promise.all([
			page.waitForResponse((res) => new URL(res.url()).pathname === "/checkout/place"),
			form.locator('input[name="email"]').press("Enter"),
		]);
		const posted = new URLSearchParams(place.request().postData() ?? "");
		expect(posted.get("intent"), "Enter did not go through the hidden enter button").toBe("enter");

		// THE ASSERTIONS: the browser sent the real origin, and the guard let it through.
		const origin = await place.request().headerValue("origin");
		expect(origin, "the browser sent an opaque Origin on the place POST").toBe(siteOrigin);
		// Under `same-origin` a same-origin POST always carries a Referer.
		const referer = await place.request().headerValue("referer");
		expect(referer, "the place POST carried no Referer").not.toBeNull();
		expect(new URL(referer ?? "").origin, "the place POST's Referer is not same-origin").toBe(
			siteOrigin,
		);
		expect(place.status(), "the place POST was refused as cross-origin").not.toBe(403);
		expect(place.status()).toBe(303);

		// And the coupon in that POST's Referer stops at the redirect.
		await page.waitForURL((url) => url.href !== before, { waitUntil: "load" });
		const landedReferrer = await page.evaluate(() => document.referrer);
		expect(
			landedReferrer,
			`${new URL(page.url()).pathname} holds the coupon in document.referrer`,
		).not.toContain(COUPON);
	});
});
