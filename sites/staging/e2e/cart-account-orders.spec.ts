/**
 * The shopper's journey from cart to their orders, in a REAL browser (issue
 * #378, the leg #40 asked for).
 *
 * product page → add to cart → checkout → place → pay step → (paid) → order
 * page → "your orders" → sign-in.
 *
 * WHERE THE JOURNEY STOPS. At the sign-in request for the address the order
 * was placed with: this spec covers the guest side (the order page's pointer
 * to the account, the Account entry in the header, the request itself). The
 * signed-in side — opening the emailed link, the order listed and opened under
 * the session, sign-out, and another address seeing none of it — is
 * `account-signed-in.spec.ts`, which reads the link the dev server captured
 * instead of mailing (`OTTA_E2E_LOGIN_CAPTURE=1`).
 *
 * HOW THE ORDER GETS PAID. The stack runs the dev-only offline Stripe gateway
 * (`OTTA_E2E_STRIPE_OFFLINE=1`, set by `playwright.config.ts` when it boots the
 * stack), so placing creates a real order with an unpayable handle. The spec
 * then pays it the way Stripe would: a signed `payment_intent.succeeded` to the
 * site's own webhook (`seed-e2e-orders.ts`'s `settleOrder`).
 *
 * IT WRITES: a cart, an order, a capture and a sign-in request. Point it only
 * at a local stack.
 */
import { cmsAuthHeaders } from "../scripts/seed-demo-commerce.js";
import {
	E2E_WEBHOOK_SECRET,
	provisionWebhookSecret,
	settleOrder,
	type SeedOrdersDeps,
} from "../scripts/seed-e2e-orders.js";
import {
	E2E_BASE_URL,
	E2E_REQUIRES_SITE,
	expect,
	skipWithoutPurchasableProduct,
	skipWithoutSite,
	test,
} from "./harness.js";

/** How many product pages to try before giving up on finding one to buy. */
const MAX_PRODUCTS_TRIED = 12;

test.describe("cart → checkout → order → account, in the browser", () => {
	// A cold storefront compiles each page on first visit; this spec visits many.
	test.slow();

	test("a placed, paid order points the shopper to their orders and to sign-in", async ({
		page,
	}, testInfo) => {
		await skipWithoutSite(testInfo);
		await page.route(/js\.stripe\.com/, (route) => route.abort());

		// ── Cart ───────────────────────────────────────────────────────────────
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
		await page.goto("/cart");
		await expect(page.locator('a[href="/checkout"]').first()).toBeVisible();

		// ── Checkout ───────────────────────────────────────────────────────────
		await page.goto("/checkout");
		// A store with zones asks where the order goes first (ADR-0021).
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
		const email = `e2e-journey-${Date.now()}@example.test`;
		await form.locator('input[name="email"]').fill(email);
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
		if ((await country.count()) > 0 && (await country.isVisible()))
			await country.selectOption("US");
		const region = form.locator('input[name="region"]');
		if ((await region.count()) > 0 && (await region.isVisible())) await region.fill("CA");

		await Promise.all([
			page.waitForURL((url) => url.pathname !== "/checkout", { waitUntil: "load" }),
			form.getByRole("button", { name: /continue to payment/i }).click(),
		]);
		if (new URL(page.url()).pathname !== "/checkout/pay") {
			// Back on /checkout: no gateway could take the order. The usual cause is a
			// dev server started without the offline gateway.
			const how =
				`placing the order did not reach the pay step (landed on ${page.url()}). Start ` +
				"the dev server with OTTA_E2E_STRIPE_OFFLINE=1 (playwright.config.ts does, when " +
				"it boots the stack) so orders can be created without a Stripe account.";
			if (E2E_REQUIRES_SITE) throw new Error(`OTTA_E2E_REQUIRE_SITE=1 and ${how}`);
			testInfo.skip(true, how);
		}

		// ── Pay (as Stripe would) ──────────────────────────────────────────────
		const orderLink = page.getByRole("link", { name: "View your order" }).last();
		const orderPath = (await orderLink.getAttribute("href")) ?? "";
		const orderId = decodeURIComponent(/^\/orders\/([^/?#]+)/.exec(orderPath)?.[1] ?? "");
		expect(orderId, `the pay step's order link is ${orderPath}`).not.toBe("");

		const deps: SeedOrdersDeps = {
			siteUrl: E2E_BASE_URL,
			authHeaders: await cmsAuthHeaders(E2E_BASE_URL),
			webhookSecret: E2E_WEBHOOK_SECRET,
		};
		await provisionWebhookSecret(deps);
		expect(await settleOrder(deps, orderId)).toBe("paid");

		// ── The order page, and the way to the account ─────────────────────────
		await orderLink.click();
		await expect(page).toHaveURL(new RegExp(`/orders/${orderId}`));
		await expect(page.locator('.stamp[data-state="paid"]')).toBeVisible();
		// A guest is pointed at sign-in with the email the order was placed with.
		const signIn = page.getByRole("link", { name: "sign in with the email you ordered with" });
		await expect(signIn).toBeVisible();

		// The header's Account entry is /account/orders, which a guest is sent on
		// from to sign-in — the same place the order page points.
		await page.getByRole("link", { name: "Account", exact: true }).first().click();
		await expect(page).toHaveURL(/\/account\/login$/);

		await page.goBack();
		await signIn.click();
		await expect(page).toHaveURL(/\/account\/login$/);
		await page.getByLabel("Email").fill(email);
		await Promise.all([
			page.waitForResponse((res) => new URL(res.url()).pathname === "/account/login/request"),
			page.getByRole("button", { name: "Email me a sign-in link" }).click(),
		]);
		await expect(page).toHaveURL(/\/account\/login\?sent=1$/);
		await expect(page.getByText("A sign-in link is on its way")).toBeVisible();
	});
});
