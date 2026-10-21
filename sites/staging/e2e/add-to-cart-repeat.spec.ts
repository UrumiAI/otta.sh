/**
 * Add to cart, pressed again, in a REAL browser (issue #37, ADR-0039).
 *
 * The product page's form used to post the ONE idempotency key the server
 * rendered into it. Going Back from the cart usually hands the same document back
 * from the history cache (bfcache), key and all, so a second press was replayed
 * as the first: no second unit, no error. The page's `add-to-cart-key.js` now
 * mints a key per submission. This spec drives the two halves end to end:
 *
 *  - Back, press again: a second unit;
 *  - a double-click (the same submission twice): exactly one unit, one key.
 *
 * WHAT THIS DOES NOT PROVE, measured rather than assumed: the history-cache case
 * itself. Headless Chromium under Playwright never restores from bfcache, even
 * with `--disable-back-forward-cache` removed from its launch args. CDP's
 * `Page.backForwardCacheNotUsed` gives `BackForwardCacheDisabledForDelegate`
 * (the automation embedder turns it off) and `BrowsingInstanceNotSwapped`,
 * nothing about the page. So `goBack()` here is always a fresh render with a
 * fresh server key, and BOTH tests would also pass against the pre-fix code. They
 * guard the journey (a re-press adds; a double-click still dedupes once the
 * script rewrites the key), not the regression.
 *
 * The regression guard is the unit tier: the script's rule, including a
 * `pageshow` with `persisted: true`, in happy-dom
 * (`test/add-to-cart-key-script.test.ts`, which fails on the pre-fix page), and
 * the store's replay-versus-add over a real store
 * (`packages/plugin/test/cart-routes.sandbox.test.ts`).
 *
 * IT WRITES: a cart per test, with up to two units of one product. Point it only
 * at a local stack. It needs a product with at least two units in stock.
 */
import type { Page } from "@playwright/test";
import { expect, skipWithoutPurchasableProduct, skipWithoutSite, test } from "./harness.js";

/** How many product pages to try before giving up on finding one to buy. */
const MAX_PRODUCTS_TRIED = 12;

const ADD_TO_CART = 'form[action="/cart/add"] button[type="submit"]';

/** A product page with an enabled add-to-cart button, or null. */
async function findPurchasableProduct(page: Page): Promise<string | null> {
	await page.goto("/products");
	const productLinks = page.locator('a[href^="/products/"]');
	await productLinks
		.first()
		.waitFor({ timeout: 10_000 })
		.catch(() => undefined);
	const hrefs = [
		...new Set(
			await productLinks.evaluateAll((links) =>
				links.map((link) => link.getAttribute("href") ?? ""),
			),
		),
	].filter((href) => /^\/products\/[^/?#]+$/.test(href));
	const addToCart = page.locator(ADD_TO_CART);
	for (const href of hrefs.slice(0, MAX_PRODUCTS_TRIED)) {
		await page.goto(href);
		if ((await addToCart.count()) > 0 && (await addToCart.first().isEnabled())) return href;
	}
	return null;
}

/** The cart's total quantity, read from the cart page's own quantity fields. */
async function cartQty(page: Page): Promise<number> {
	const values = await page
		.locator('form[action="/cart/update"] input[name="qty"]')
		.evaluateAll((inputs) => inputs.map((input) => Number((input as HTMLInputElement).value)));
	return values.reduce((sum, qty) => sum + qty, 0);
}

/** One press, through to the cart page the add redirects to. */
async function pressAddToCart(page: Page): Promise<void> {
	await Promise.all([page.waitForURL(/\/cart(\?|$)/), page.locator(ADD_TO_CART).first().click()]);
}

test.describe("add to cart, pressed again (issue #37)", () => {
	// A cold storefront compiles each page on first visit.
	test.slow();

	test("Back to the product page and press again: a second unit", async ({ page }, testInfo) => {
		await skipWithoutSite(testInfo);
		const href = await findPurchasableProduct(page);
		if (href === null) return skipWithoutPurchasableProduct(testInfo);

		await pressAddToCart(page);
		expect(await cartQty(page)).toBe(1);

		// The browser's own Back. Under Playwright this is always a fresh render
		// (see the module doc), so it proves the re-press path works end to end,
		// not the history-cache case itself.
		await page.goBack();
		await expect(page).toHaveURL(new RegExp(`${href}$`));
		await pressAddToCart(page);
		expect(await cartQty(page)).toBe(2);
	});

	test("a double-click is one submission: exactly one unit", async ({ page }, testInfo) => {
		await skipWithoutSite(testInfo);
		const href = await findPurchasableProduct(page);
		if (href === null) return skipWithoutPurchasableProduct(testInfo);

		const adds: string[] = [];
		page.on("request", (request) => {
			if (new URL(request.url()).pathname === "/cart/add" && request.method() === "POST") {
				adds.push(new URLSearchParams(request.postData() ?? "").get("idempotencyKey") ?? "");
			}
		});
		await Promise.all([
			page.waitForURL(/\/cart(\?|$)/),
			page.locator(ADD_TO_CART).first().dblclick(),
		]);
		expect(await cartQty(page)).toBe(1);
		// However many POSTs the double-click produced, they share one key — which
		// is why the store replayed the second rather than adding it.
		expect(adds.length).toBeGreaterThan(0);
		expect(new Set(adds).size).toBe(1);
	});
});
