/**
 * Cash on delivery, end to end, on a store with NO card payment (ADR-0042).
 *
 * The buyer adds a product to the cart, checks out with cash on delivery, the
 * only method offered, and lands on the order's confirmation page. There is no
 * pay page. The merchant then opens the order in the Orders console and marks
 * it paid, which is the one way a COD order becomes paid.
 *
 * STRIPE UNCONFIGURED, FOR REAL. The e2e stack arms card checkout with the
 * offline gateway: a placeholder publishable key plus the e2e webhook secret
 * (global-setup). This spec removes that webhook secret, so card payment reads
 * "not set up" exactly as on a store that never configured Stripe, and puts it
 * back afterwards. It refuses to touch a store that holds a real Stripe SECRET
 * key, because that is not the e2e stack. Cash on delivery is switched on for
 * the run and off again at the end.
 *
 * IT WRITES. One COD order is placed and marked paid, and its stock is committed.
 * Point it only at a local stack.
 */
import { cmsAuthHeaders } from "../scripts/seed-demo-commerce.js";
import {
	E2E_WEBHOOK_SECRET,
	stripeSecretKeyIsSet,
	stripeWebhookSecretIsSet,
} from "../scripts/seed-e2e-orders.js";
import {
	ADMIN_SHELL_TIMEOUT_MS,
	E2E_BASE_URL,
	OTTA_PLUGIN_ID,
	REPO_ROOT,
	consoleScreenUrl,
	dismissWelcomeDialog,
	expect,
	skipWithoutPurchasableProduct,
	skipWithoutSite,
	test,
} from "./harness.js";

const SHOT_DIR = `${REPO_ROOT}/node_modules/.playwright-artifacts`;
const ADMIN_ROUTE = `${E2E_BASE_URL}/_emdash/api/plugins/${OTTA_PLUGIN_ID}/admin`;
const INSTRUCTIONS = "Please have the exact amount ready.";
const MAX_PRODUCTS_TRIED = 12;

/** POST one admin-route interaction (the Settings page's own form submits). */
async function adminCall(headers: Record<string, string>, body: unknown): Promise<unknown> {
	const res = await fetch(ADMIN_ROUTE, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`admin route → HTTP ${res.status}: ${await res.text()}`);
	const envelope = (await res.json()) as { success?: unknown; data?: unknown };
	if (envelope.success !== true)
		throw new Error(`admin route refused: ${JSON.stringify(envelope)}`);
	return envelope.data;
}

const saveCod = (headers: Record<string, string>, codEnabled: boolean) =>
	adminCall(headers, {
		type: "form_submit",
		action_id: "save-cash-on-delivery",
		values: { codEnabled, codInstructions: codEnabled ? INSTRUCTIONS : "" },
	});

test.describe("cash on delivery with Stripe unconfigured", () => {
	test.slow();

	let headers: Record<string, string> = {};
	/** Whether this run removed the e2e webhook secret, and so owes it back. */
	let removedWebhookSecret = false;

	test.beforeAll(async () => {
		headers = await cmsAuthHeaders(E2E_BASE_URL);
	});

	test.afterAll(async () => {
		if (Object.keys(headers).length === 0) return;
		await saveCod(headers, false).catch(() => undefined);
		if (removedWebhookSecret) {
			await adminCall(headers, {
				type: "form_submit",
				action_id: "save-stripe-webhook-secret",
				values: { stripeWebhookSecret: E2E_WEBHOOK_SECRET },
			});
		}
	});

	test("checkout places a COD order with no pay page, and the admin marks it paid", async ({
		page,
	}, testInfo) => {
		await skipWithoutSite(testInfo);

		// -- the store: no card payment, cash on delivery on ----------------------
		const settings = await adminCall(headers, { type: "page_load", page: "/settings" });
		if (stripeSecretKeyIsSet(settings)) {
			testInfo.skip(true, "this store holds a real Stripe secret key; not the e2e stack");
		}
		if (stripeWebhookSecretIsSet(settings)) {
			await adminCall(headers, {
				type: "block_action",
				action_id: "clear-payment-secret",
				value: { secret: "stripeWebhookSecret" },
			});
			removedWebhookSecret = true;
		}
		await saveCod(headers, true);

		// -- the buyer -----------------------------------------------------------
		await page.route(/js\.stripe\.com/, (route) => route.abort());
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
		await page.waitForLoadState("load");

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
		// Cash on delivery is the ONLY method: no choice, the instructions shown,
		// and the button places the order rather than continuing to a payment.
		await expect(page.getByTestId("payment-methods")).toHaveCount(0);
		await expect(page.getByTestId("payment-method-cod-only")).toContainText(INSTRUCTIONS);
		await expect(form.locator('input[name="paymentMethod"]')).toHaveValue("cod");
		const submit = form.getByRole("button", { name: "Place order" });
		await expect(submit).toBeVisible();

		await form.locator('input[name="email"]').fill(`e2e-cod-${Date.now()}@example.test`);
		for (const [name, value] of [
			["name", "E2E Cash Buyer"],
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
					page.waitForResponse((res) => new URL(res.url()).pathname === "/checkout/place"),
					update.click(),
				]);
				await page.waitForLoadState("load");
			}
		}
		const region = form.locator('select[name="region"]');
		if ((await region.count()) > 0 && (await region.isVisible())) await region.selectOption("CA");

		await Promise.all([page.waitForURL(/\/orders\/[^/?#]+$/), submit.click()]);
		// Straight to the confirmation: never the Stripe pay page.
		expect(page.url()).not.toContain("/checkout/pay");
		const orderId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "");
		expect(orderId.length).toBeGreaterThan(0);
		await expect(page.getByText("Order placed.")).toBeVisible();
		await expect(
			page.getByText("You'll pay in cash when your order is delivered.", { exact: false }),
		).toBeVisible();
		await expect(page.getByRole("link", { name: /complete payment/i })).toHaveCount(0);
		await expect(page.getByRole("button", { name: /check again/i })).toHaveCount(0);
		await page.screenshot({ path: `${SHOT_DIR}/cash-on-delivery-confirmation.png` });

		// -- the merchant marks it paid ---------------------------------------
		const signIn = await page.goto("/_emdash/api/auth/dev-bypass");
		expect(signIn?.status() ?? 599).toBeLessThan(400);
		await page.goto(`${consoleScreenUrl("/orders")}?order=${encodeURIComponent(orderId)}`);
		await expect(page.getByTestId("detail-heading")).toBeVisible({
			timeout: ADMIN_SHELL_TIMEOUT_MS,
		});
		await dismissWelcomeDialog(page);
		await expect(page.getByTestId("detail-full-id")).toHaveText(orderId);
		await expect(page.getByTestId("detail-payment-method")).toHaveText("Cash on delivery");
		await expect(page.getByTestId("detail-state-pill")).toContainText(/pending/i);
		// The status moves sit on the Fulfilment tab.
		await page.getByRole("tab", { name: "Fulfilment" }).click();
		const markPaid = page.getByTestId("transition-paid");
		await expect(markPaid).toBeVisible();
		await markPaid.click();
		const confirm = page.getByRole("dialog").getByRole("button", { name: /mark paid|confirm/i });
		if ((await confirm.count()) > 0) await confirm.first().click();
		await expect(page.getByTestId("detail-state-pill")).toContainText(/paid/i, {
			timeout: 20_000,
		});
		await expect(page.getByTestId("transition-paid")).toHaveCount(0);
		await page.screenshot({ path: `${SHOT_DIR}/cash-on-delivery-admin-marked-paid.png` });

		// The buyer's page now says the order is confirmed.
		await page.goto(`/orders/${encodeURIComponent(orderId)}`);
		await expect(page.getByText("Order confirmed.")).toBeVisible();
	});
});
