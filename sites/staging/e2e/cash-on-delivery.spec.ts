/**
 * Cash on delivery, end to end, on a store with NO card payment (ADR-0044).
 *
 * The buyer adds a product to the cart, checks out with cash on delivery (the
 * only method offered) with a delivery address and a phone, and lands on the
 * confirmation page: "Order placed." There is no pay page. Adding to cart again
 * starts a NEW cart (the placed order's cart is spent, review finding 1) and
 * leaves the order awaiting payment. The merchant then records the shipment
 * with tracking (shipped, awaiting payment), marks it paid on delivery through
 * the cash confirm (delivered) and completes it, and the buyer's page says the
 * payment was received.
 *
 * STRIPE UNCONFIGURED, FOR REAL. The e2e stack arms card checkout with the
 * offline gateway: a placeholder publishable key plus the e2e webhook secret
 * (global-setup). This spec removes that webhook secret, so card payment reads
 * "not set up" exactly as on a store that never configured Stripe, and puts it
 * back afterwards. It refuses to touch a store that holds a real Stripe SECRET
 * key, because that is not the e2e stack. Cash on delivery is switched on for
 * the run and off again at the end.
 *
 * THE WRITE LIMIT. COD is offered only where the site has the RATE_LIMIT_WRITES
 * binding (decision C1). The stack playwright.config.ts boots runs on
 * wrangler.e2e.jsonc, which adds it (OTTA_E2E_WRITE_LIMIT=1); a server started
 * any other way has no COD to offer, and this spec skips.
 *
 * IT WRITES. One COD order is placed, shipped, paid and completed, and its
 * stock is committed. Point it only at a local stack.
 */
import { cmsAuthHeaders } from "../../store/scripts/seed-demo-commerce.js";
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

	test("a COD order is placed, ships unpaid, is marked paid on delivery and completed", async ({
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
		// A product that SHIPS: cash on delivery is for physical carts only
		// (decision D), so the checkout below must offer it.
		let productHref: string | undefined;
		for (const href of hrefs.slice(0, MAX_PRODUCTS_TRIED)) {
			await page.goto(href);
			if ((await addToCart.count()) > 0 && (await addToCart.first().isEnabled())) {
				productHref = href;
				break;
			}
		}
		if (productHref === undefined) await skipWithoutPurchasableProduct(testInfo);
		await Promise.all([
			page.waitForResponse((res) => new URL(res.url()).pathname === "/cart/add"),
			addToCart.first().click(),
		]);
		await page.waitForLoadState("load");

		const cartCookie = async (): Promise<string | undefined> =>
			(await page.context().cookies()).find((cookie) => cookie.name === "otta_cart")?.value;

		await page.goto("/checkout");
		// No COD on this page ⇒ the server was not started with the write limit
		// (OTTA_E2E_WRITE_LIMIT=1, wrangler.e2e.jsonc): not this spec's stack.
		if ((await page.locator('input[name="paymentMethod"][value="cod"]').count()) === 0) {
			testInfo.skip(
				true,
				"cash on delivery is not offered: start the stack with OTTA_E2E_START_STACK=1, which " +
					"runs it on wrangler.e2e.jsonc with the RATE_LIMIT_WRITES binding",
			);
		}
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
		await expect(form.getByText("Continue to payment")).toHaveCount(0);
		// The phone is asked for, and marked required (decision D).
		await expect(form.locator('label[for="address-phone"]')).toContainText("required");

		await form.locator('input[name="email"]').fill(`e2e-cod-${Date.now()}@example.test`);
		const fillAddress = async (): Promise<void> => {
			for (const [name, value] of [
				["name", "E2E Cash Buyer"],
				["line1", "1 Test Street"],
				["city", "Springfield"],
				["postalCode", "12345"],
				["phone", "+1 555 0100"],
			] as const) {
				const field = form.locator(`input[name="${name}"]`);
				if ((await field.count()) > 0 && (await field.isVisible())) await field.fill(value);
			}
		};
		await fillAddress();
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
				// The round trip keeps what was typed (the draft); fill anything it did not.
				await fillAddress();
			}
		}
		const region = form.locator('select[name="region"]');
		if ((await region.count()) > 0 && (await region.isVisible())) await region.selectOption("CA");

		const placedCart = await cartCookie();
		await Promise.all([page.waitForURL(/\/orders\/[^/?#]+$/), submit.click()]);
		// Straight to the confirmation: never the Stripe pay page.
		expect(page.url()).not.toContain("/checkout/pay");
		const orderId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "");
		expect(orderId.length).toBeGreaterThan(0);
		const buyerPage = `/orders/${encodeURIComponent(orderId)}`;
		await expect(page.getByText("Order placed.")).toBeVisible();
		await expect(
			page.getByText("You'll pay in cash when your order is delivered.", { exact: false }),
		).toBeVisible();
		await expect(page.getByText(/emailed/i)).toHaveCount(0);
		await expect(page.getByRole("link", { name: /complete payment/i })).toHaveCount(0);
		await expect(page.getByRole("button", { name: /check again/i })).toHaveCount(0);
		await page.screenshot({ path: `${SHOT_DIR}/cash-on-delivery-confirmation.png` });

		// -- the spent cart (review finding 1): the next add starts a new cart ----
		// The confirmation page forgot the placed order's cart cookie.
		expect(placedCart).toBeDefined();
		expect(await cartCookie()).not.toBe(placedCart);
		await page.goto(productHref ?? "/products");
		await Promise.all([
			page.waitForResponse((res) => new URL(res.url()).pathname === "/cart/add"),
			addToCart.first().click(),
		]);
		await page.waitForLoadState("load");
		expect(page.url()).not.toMatch(/error=/);
		const newCart = await cartCookie();
		expect(newCart).toBeDefined();
		expect(newCart).not.toBe(placedCart);
		// …and the COD order is untouched: still placed, awaiting its cash.
		await page.goto(buyerPage);
		await expect(page.getByText("Order placed.")).toBeVisible();

		// -- the merchant: record the shipment, then the cash on delivery --------
		const signIn = await page.goto("/_emdash/api/auth/dev-bypass");
		expect(signIn?.status() ?? 599).toBeLessThan(400);
		await page.goto(`${consoleScreenUrl("/orders")}?order=${encodeURIComponent(orderId)}`);
		await expect(page.getByTestId("detail-heading")).toBeVisible({
			timeout: ADMIN_SHELL_TIMEOUT_MS,
		});
		await dismissWelcomeDialog(page);
		await expect(page.getByTestId("detail-full-id")).toHaveText(orderId);
		await expect(page.getByTestId("detail-payment-method")).toHaveText("Cash on delivery");
		const statePill = page.getByTestId("detail-state-pill");
		await expect(statePill).toHaveText("awaiting payment");

		// The shipment and the status moves sit on the Fulfilment tab.
		await page.getByRole("tab", { name: "Fulfilment" }).click();
		await page.getByTestId("fulfil-carrier").fill("E2E Courier");
		await page.getByTestId("fulfil-tracking").fill(`COD-${Date.now()}`);
		await page.getByTestId("fulfil-by").fill("e2e operator");
		await page.getByTestId("fulfil-submit").click();
		await expect(statePill).toHaveText("shipped, awaiting payment", { timeout: 20_000 });

		const markPaid = page.getByTestId("transition-delivered");
		await expect(markPaid).toHaveText("Mark paid (delivered)");
		await markPaid.click();
		await expect(page.getByTestId("otta-confirm-text")).toHaveText(
			/^Confirm you received .+ in cash\. This records the payment and emails the buyer\.$/,
		);
		await page.getByTestId("otta-confirm-yes").click();
		await expect(statePill).toHaveText("delivered", { timeout: 20_000 });

		const complete = page.getByTestId("transition-completed");
		await expect(complete).toBeVisible();
		await complete.click();
		await expect(statePill).toHaveText("completed", { timeout: 20_000 });
		await page.screenshot({ path: `${SHOT_DIR}/cash-on-delivery-admin-completed.png` });

		// The buyer's page now says the cash was received.
		await page.goto(buyerPage);
		await expect(page.getByText("Payment received — thank you.")).toBeVisible();
	});
});
