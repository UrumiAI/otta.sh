/**
 * #604 — a declined card on /checkout/pay is announced and focused, in a REAL
 * browser.
 *
 * WHY STRIPE IS STUBBED. The e2e stack runs the dev-only OFFLINE Stripe gateway
 * (`OTTA_E2E_STRIPE_OFFLINE=1`): a placed order carries an unpayable client
 * secret, so a real Payment Element cannot even mount, and a real decline with
 * test card 4000000000000002 needs Stripe's network — which this suite must
 * not depend on. So `js.stripe.com` is answered by a local stand-in whose
 * `confirmPayment` answers exactly what Stripe answers for that card
 * (`card_declined`, "Your card was declined."). Everything after that is the
 * page's own inline script: `fail()`, the alert region, the focus.
 *
 * `test/pay-error-announce.test.ts` pins the same behaviour against the
 * script in happy-dom; this proves it in a browser's real focus and live-region
 * DOM, including the second, identical decline.
 *
 * IT WRITES: a cart and a pending order (its hold lapses on its own). Point it
 * only at a local stack.
 */
import {
	E2E_REQUIRES_SITE,
	expect,
	skipWithoutPurchasableProduct,
	skipWithoutSite,
	test,
} from "./harness.js";

const MAX_PRODUCTS_TRIED = 12;
const DECLINE = "Your card was declined.";

/** Stripe.js, as far as the pay page uses it, with test card 4000000000000002's answer. */
const STRIPE_STUB = `
window.Stripe = function () {
	return {
		elements: function () {
			return {
				create: function () {
					return {
						mount: function (selector) {
							var node = document.querySelector(selector);
							if (node) node.appendChild(document.createElement("div"));
						},
						destroy: function () {},
					};
				},
				update: function () {},
			};
		},
		confirmPayment: function () {
			return Promise.resolve({ error: { type: "card_error", code: "card_declined", decline_code: "generic_decline", message: ${JSON.stringify(DECLINE)} } });
		},
	};
};`;

test.describe("a declined card on the pay page (#604)", () => {
	test.slow();

	test("is said in the alert region, focused, and said again on a repeat", async ({
		page,
	}, testInfo) => {
		await skipWithoutSite(testInfo);
		await page.route(/js\.stripe\.com/, (route) =>
			route.fulfill({ status: 200, contentType: "application/javascript", body: STRIPE_STUB }),
		);

		// ── A cart ─────────────────────────────────────────────────────────────
		await page.goto("/products");
		const links = page.locator('a[href^="/products/"]');
		await links
			.first()
			.waitFor({ timeout: 10_000 })
			.catch(() => undefined);
		const hrefs = [
			...new Set(await links.evaluateAll((all) => all.map((a) => a.getAttribute("href") ?? ""))),
		].filter((href) => /^\/products\/[^/?#]+$/.test(href));
		const addToCart = page.locator('form[action="/cart/add"] button[type="submit"]');
		let found = false;
		for (const href of hrefs.slice(0, MAX_PRODUCTS_TRIED)) {
			await page.goto(href);
			if ((await addToCart.count()) > 0 && (await addToCart.first().isEnabled())) {
				found = true;
				break;
			}
		}
		if (!found) return skipWithoutPurchasableProduct(testInfo);
		await Promise.all([
			page.waitForResponse((res) => new URL(res.url()).pathname === "/cart/add"),
			addToCart.first().click(),
		]);

		// ── Place (the same steps as cart-account-orders.spec.ts) ──────────────
		await page.goto("/checkout");
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
		const form = page.locator('form[action="/checkout/place"]');
		await form.locator('input[name="email"]').fill(`e2e-decline-${Date.now()}@example.test`);
		for (const [name, value] of [
			["name", "E2E Shopper"],
			["line1", "1 Test Street"],
			["city", "Springfield"],
			["postalCode", "12345"],
		] as const) {
			const field = form.locator(`input[name="${name}"]`);
			if ((await field.count()) > 0 && (await field.isVisible())) await field.fill(value);
		}
		const country = form.locator('select[name="country"]');
		if ((await country.count()) > 0 && (await country.isVisible())) {
			await country.selectOption("US");
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
		}
		const region = form.locator('select[name="region"]');
		if ((await region.count()) > 0 && (await region.isVisible())) await region.selectOption("CA");
		await Promise.all([
			page.waitForURL((url) => url.pathname !== "/checkout", { waitUntil: "load" }),
			form.getByRole("button", { name: /continue to payment/i }).click(),
		]);
		if (new URL(page.url()).pathname !== "/checkout/pay") {
			const how =
				`placing the order did not reach the pay step (landed on ${page.url()}). Start ` +
				"the dev server with OTTA_E2E_STRIPE_OFFLINE=1 (playwright.config.ts does, when " +
				"it boots the stack) so orders can be created without a Stripe account.";
			if (E2E_REQUIRES_SITE) throw new Error(`OTTA_E2E_REQUIRE_SITE=1 and ${how}`);
			testInfo.skip(true, how);
		}

		// ── Pay: declined ──────────────────────────────────────────────────────
		const alertRegion = page.locator("#payment-error");
		const message = page.locator("#payment-error-text");
		const pay = page.locator("#payment-submit");
		// Present from first render, and NOT hidden — only its text is.
		await expect(alertRegion).toHaveAttribute("role", "alert");
		await expect(alertRegion).toHaveAttribute("tabindex", "-1");
		expect(await alertRegion.evaluate((el) => (el as HTMLElement).hidden)).toBe(false);
		await expect(message).toBeHidden();

		await expect(pay).toBeEnabled();
		await pay.click();
		await expect(message).toBeVisible();
		await expect(message).toHaveText(DECLINE);
		await expect(alertRegion).toBeFocused();
		await expect(pay).toBeEnabled();

		// The same decline again: the text is cleared and set again — the change
		// the alert region announces — and focus returns to it.
		await message.evaluate((el) => {
			const w = window as unknown as { seenTexts: string[] };
			w.seenTexts = [];
			new MutationObserver(() => w.seenTexts.push(el.textContent ?? "")).observe(el, {
				childList: true,
				characterData: true,
				subtree: true,
			});
		});
		await pay.click();
		await expect(alertRegion).toBeFocused();
		await expect(message).toHaveText(DECLINE);
		const seen = await page.evaluate(
			() => (window as unknown as { seenTexts: string[] }).seenTexts,
		);
		expect(seen).toContain("");
		expect(seen.at(-1)).toBe(DECLINE);
	});
});
