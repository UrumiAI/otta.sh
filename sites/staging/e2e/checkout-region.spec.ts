/**
 * The state/province PICK LIST at checkout, in a real browser with JavaScript
 * OFF — the review has no client JS, and this proves it needs none.
 *
 * The list is rendered on the server for the country the page knows. Choosing
 * another country and pressing Update is a round trip that comes back with that
 * country's subdivisions (by name; the code is what posts) and every typed
 * value kept. A country without subdivisions shows no region field, and a
 * region picked for one country is never placed as another's: placing after a
 * country change comes back with the new list instead.
 *
 * Runs on a stack whose cart ships with no zones configured (the seeded e2e
 * stack): the address block then asks for its own country. A store with zones
 * asks in its delivery block instead, which the render suite covers
 * (test/regions.test.ts). IT WRITES: it adds a product to a new cart.
 */
import {
	expect,
	skipWithoutPlaceButton,
	skipWithoutPurchasableProduct,
	skipWithoutSite,
	test,
} from "./harness.js";

const MAX_PRODUCTS_TRIED = 12;

test.use({ javaScriptEnabled: false });

test.describe("the state/province pick list (no client JS)", () => {
	test("Update swaps the list for the chosen country and keeps every typed value", async ({
		page,
	}, testInfo) => {
		await skipWithoutSite(testInfo);

		await page.goto("/products");
		const hrefs = [
			...new Set(
				await page
					.locator('a[href^="/products/"]')
					.evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? "")),
			),
		].filter((href) => /^\/products\/[^/?#]+$/.test(href));
		const addToCart = page.locator('form[action="/cart/add"] button[type="submit"]');
		let purchasable = false;
		for (const href of hrefs.slice(0, MAX_PRODUCTS_TRIED)) {
			await page.goto(href);
			if ((await addToCart.count()) > 0 && (await addToCart.first().isEnabled())) {
				purchasable = true;
				break;
			}
		}
		if (!purchasable) await skipWithoutPurchasableProduct(testInfo);
		await Promise.all([
			page.waitForResponse((res) => new URL(res.url()).pathname === "/cart/add"),
			addToCart.first().click(),
		]);
		await page.waitForLoadState("load");

		await page.goto("/checkout");
		const form = page.locator("form#checkout-place");
		const country = form.locator('select[name="country"]');
		if ((await country.count()) === 0) {
			// A store with zones: the address block's country is the hidden priced
			// destination, and this spec's subject is not on the page.
			testInfo.skip(true, "a store with zones: the address block has no country of its own");
		}

		// No country yet: no region field.
		await expect(form.locator('select[name="region"]')).toHaveCount(0);

		await form.locator('input[name="email"]').fill("region-e2e@example.test");
		await form.locator('input[name="name"]').fill("Asha Rao");
		await form.locator('input[name="line1"]').fill("12 MG Road");
		await form.locator('input[name="city"]').fill("Bengaluru");
		await form.locator('input[name="postalCode"]').fill("560001");

		// India → Update: the round trip brings India's states, by name.
		await country.selectOption("IN");
		await Promise.all([
			page.waitForURL(/\/checkout(\?|$)/, { waitUntil: "load" }),
			form.locator('button[value="update-address"]').click(),
		]);
		const region = form.locator('select[name="region"]');
		await expect(region).toBeVisible();
		await expect(page.getByLabel("State / province")).toBeVisible();
		await expect(region.locator('option[value="KA"]')).toHaveText("Karnataka");
		await expect(region.locator('option[value="CA"]')).toHaveCount(0);
		// Everything typed came back (the draft cookie, never the URL).
		expect(page.url()).not.toContain("Asha");
		await expect(form.locator('input[name="email"]')).toHaveValue("region-e2e@example.test");
		await expect(form.locator('input[name="name"]')).toHaveValue("Asha Rao");
		await expect(form.locator('input[name="city"]')).toHaveValue("Bengaluru");
		await expect(country).toHaveValue("IN");

		await region.selectOption("KA");
		await Promise.all([
			page.waitForURL(/\/checkout(\?|$)/, { waitUntil: "load" }),
			form.locator('button[value="update-address"]').click(),
		]);
		// The picked code is kept and shown as the selected NAME.
		await expect(region).toHaveValue("KA");
		await expect(region.locator("option:checked")).toHaveText("Karnataka");

		// Changing the country and placing straight away does NOT place India's
		// state for the US: the review comes back with the US list instead.
		await country.selectOption("US");
		const submit = form.locator('button[type="submit"]:not([value])');
		if ((await submit.count()) === 0) {
			await skipWithoutPlaceButton(testInfo, "no Continue to payment button");
		}
		const [place] = await Promise.all([
			page.waitForResponse((res) => new URL(res.url()).pathname === "/checkout/place"),
			submit.click(),
		]);
		expect(place.status()).toBe(303);
		await page.waitForURL(/error=REGION_LIST_UPDATED/, { waitUntil: "load" });
		await expect(page.getByText(/updated the state\/province list/i)).toBeVisible();
		await expect(country).toHaveValue("US");
		await expect(region).toHaveValue("");
		await expect(region.locator('option[value="CA"]')).toHaveText("California");
		await expect(form.locator('input[name="name"]')).toHaveValue("Asha Rao");

		// A country with no subdivisions: no region field at all.
		await country.selectOption("AQ");
		await Promise.all([
			page.waitForURL(/\/checkout(\?|$)/, { waitUntil: "load" }),
			form.locator('button[value="update-address"]').click(),
		]);
		await expect(form.locator('select[name="region"]')).toHaveCount(0);
		await expect(country).toHaveValue("AQ");
	});
});
