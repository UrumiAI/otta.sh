/**
 * #603 — a refusal that lands after a redirect is announced and focused, in a
 * REAL browser.
 *
 * `test/error-notice.test.ts` pins the pieces (the "Error: " title, the notice's
 * `role="alert"` + `tabindex="-1"` + id, the redirect's fragment). Only a browser
 * shows they add up: the 303's Location fragment survives into the landed URL,
 * the notice is the `:target`, and fragment navigation moves focus onto it —
 * with no script, the way the checkout works.
 *
 * The refusal is a real one: an add-to-cart quantity over the site's cap
 * (QTY_TOO_LARGE), refused by `/cart/add` before any dispatch, so it writes
 * nothing and needs no cart. The field's own `max` would stop the browser from
 * sending it, so the spec lifts it first.
 */
import { expect, skipWithoutPurchasableProduct, skipWithoutSite, test } from "./harness.js";

const MAX_PRODUCTS_TRIED = 12;
const ADD_TO_CART = 'form[action="/cart/add"] button[type="submit"]';

test.describe("a refused POST comes back announced and focused (#603)", () => {
	test.slow();

	test("a refused add lands on the product page's notice", async ({ page }, testInfo) => {
		await skipWithoutSite(testInfo);
		await page.goto("/products");
		const links = page.locator('a[href^="/products/"]');
		await links
			.first()
			.waitFor({ timeout: 10_000 })
			.catch(() => undefined);
		const hrefs = [
			...new Set(await links.evaluateAll((all) => all.map((a) => a.getAttribute("href") ?? ""))),
		].filter((href) => /^\/products\/[^/?#]+$/.test(href));
		const addToCart = page.locator(ADD_TO_CART);
		let found = false;
		for (const href of hrefs.slice(0, MAX_PRODUCTS_TRIED)) {
			await page.goto(href);
			if ((await addToCart.count()) > 0 && (await addToCart.first().isEnabled())) {
				found = true;
				break;
			}
		}
		if (!found) return skipWithoutPurchasableProduct(testInfo);

		const qty = page.locator('form[action="/cart/add"] input[name="qty"]').first();
		await qty.evaluate((input) => input.removeAttribute("max"));
		await qty.fill("99999");
		await Promise.all([page.waitForURL(/#product-error$/), addToCart.first().click()]);
		await page.waitForLoadState("load");

		expect(await page.title()).toMatch(/^Error: /);
		const notice = page.locator("#product-error");
		await expect(notice).toHaveAttribute("role", "alert");
		await expect(notice).toHaveAttribute("tabindex", "-1");
		expect(await page.evaluate(() => document.querySelector(":target")?.id ?? null)).toBe(
			"product-error",
		);
		await expect(notice).toBeFocused();
	});
});
