/**
 * Add to cart, pressed again, in a REAL browser (issue #37, ADR-0039).
 *
 * The product page's form used to post the ONE idempotency key the server
 * rendered into it. Going Back from the cart usually hands the same document back
 * from the history cache, key and all, so a second press was replayed as the
 * first: no second unit, no error. The page's `add-to-cart-key.js` now mints a
 * key per submission, and this spec drives the two halves of that rule:
 *
 *  - an intentional second press — Back, press again — ADDS a unit;
 *  - a double-click (the same submission twice) still adds exactly ONE.
 *
 * The unit tier pins the script's rule in happy-dom
 * (`test/add-to-cart-key-script.test.ts`) and the store's replay-vs-add over a
 * real store (`packages/plugin/test/cart-routes.sandbox.test.ts`). This is the
 * browser's own history cache and its own double submit, which neither can fake.
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

	test("Back to the product page and press again: a second unit, not a silent replay", async ({
		page,
	}, testInfo) => {
		await skipWithoutSite(testInfo);
		const href = await findPurchasableProduct(page);
		if (href === null) return skipWithoutPurchasableProduct(testInfo);

		await pressAddToCart(page);
		expect(await cartQty(page)).toBe(1);

		// The browser's own Back: the product page as the history cache keeps it
		// (or a fresh render, where it does not) — either way, a NEW press.
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
