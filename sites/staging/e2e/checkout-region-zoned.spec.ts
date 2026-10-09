/**
 * The state/province pick list on a store with a STATE-LEVEL zone, in a real
 * browser with JavaScript OFF.
 *
 * A zone that lists `US-CA` makes the plugin refuse a plain `US` destination
 * (SHIPPING_REGION_CODE_REQUIRED): delivery there depends on the state. The
 * review must then keep United States chosen and SHOW its state list — a
 * refusal that asked for a state from a list it did not print left the buyer
 * with no way on (review B1). Here: choose US → Update delivery → the state list
 * is there and marked → choose California → Update delivery → the zone's option
 * is priced → the order is placed and reaches the pay step.
 *
 * IT WRITES, and it puts the store's shipping BACK: the zone, method and rate it
 * creates through the plugin's admin route are deleted afterwards (rate, method,
 * zone), so the specs after it still see a store with no zones. It adds a
 * product to a new cart and places an order (offline Stripe gateway).
 */
import { admin, adminHeaders, everything, formBlockId, pathToken } from "./admin-rules.js";
import {
	expect,
	skipWithoutPlaceButton,
	skipWithoutPurchasableProduct,
	skipWithoutSite,
	test,
} from "./harness.js";

const ZONE = "e2e-us-ca";
const METHOD = "e2e-us-ca-std";
test.use({ javaScriptEnabled: false });

test.describe("the state/province pick list on a store with a state-level zone (no client JS)", () => {
	let headers: Record<string, string> = {};

	test.afterAll(async () => {
		if (headers["Cookie"] === undefined) return;
		// Put the store's shipping back, innermost first.
		await admin(headers, {
			type: "block_action",
			action_id: "shipping:delete-rate",
			value: { zoneId: ZONE, methodId: METHOD, currency: "USD" },
		});
		await admin(headers, {
			type: "block_action",
			action_id: "shipping:delete-method",
			value: { zoneId: ZONE, methodId: METHOD },
		});
		const blocks = await admin(headers, {
			type: "block_action",
			action_id: "shipping:delete-zone",
			value: { zoneId: ZONE },
		});
		expect(JSON.stringify(blocks)).not.toContain(`ship:zone:${ZONE}`);
	});

	test("US is refused without a state, the list is shown, California is priced and the order is placed", async ({
		page,
	}, testInfo) => {
		await skipWithoutSite(testInfo);

		// ── The zone: US-CA only, one flat USD rate ────────────────────────────
		headers = await adminHeaders();
		await admin(headers, {
			type: "form_submit",
			action_id: "shipping:create-zone",
			values: { id: ZONE, name: "California", regions: "US-CA", ackFirstZone: true },
		});
		const methods = await admin(headers, {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: pathToken([ZONE]) },
		});
		// The method's create form is a drill-in behind the level's promoted
		// "New shipping method" button, whose value carries the zone.
		const newMethod = everything(methods).find(
			(b) => b["action_id"] === "shipping:open-create-method",
		);
		const createMethod = await admin(headers, {
			type: "block_action",
			action_id: "shipping:open-create-method",
			value: newMethod?.["value"],
		});
		await admin(headers, {
			type: "form_submit",
			action_id: "shipping:create-method",
			values: { id: METHOD, name: "California Standard", type: "flat_rate" },
			block_id: formBlockId(createMethod, "shipping:create-method"),
		});
		const rates = await admin(headers, {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: pathToken([ZONE, METHOD]) },
		});
		const rated = await admin(headers, {
			type: "form_submit",
			action_id: "shipping:create-rate",
			values: { currency: "USD", amount: "5.00", minSubtotal: "" },
			block_id: formBlockId(rates, "shipping:create-rate"),
		});
		expect(JSON.stringify(rated), "the USD rate was not created").toContain("USD");

		// ── A cart ─────────────────────────────────────────────────────────────
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
		for (const href of hrefs.slice(0, 12)) {
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

		// ── The delivery block ─────────────────────────────────────────────────
		await page.goto("/checkout");
		const delivery = page.locator("#delivery");
		await expect(delivery).toBeVisible();
		const country = delivery.locator('select[name="deliveryCountry"]');
		const update = delivery.locator('button[value="update-delivery"]');
		const region = delivery.locator('select[name="deliveryRegion"]');

		// A FIRST-TIME buyer (no country chosen, no JS): the store's own country —
		// its only zone's, US — is preselected, and its state list is ALREADY on
		// the page: no Update needed to see it.
		await expect(country).toHaveValue("US");
		await expect(region).toBeVisible();
		await expect(region.locator('option[value="CA"]')).toHaveText("California");
		await expect(region).not.toHaveAttribute("aria-invalid", "true");

		await country.selectOption("US");
		await Promise.all([page.waitForURL(/country=US/, { waitUntil: "load" }), update.click()]);
		// Refused without a state — and the state list is RIGHT THERE, US kept.
		await expect(country).toHaveValue("US");
		await expect(region).toBeVisible();
		await expect(region).toHaveAttribute("aria-invalid", "true");
		await expect(region.locator('option[value="CA"]')).toHaveText("California");
		await expect(page.locator("#delivery-error")).toContainText(/state\/province/i);

		await region.selectOption("CA");
		await Promise.all([page.waitForURL(/region=CA/, { waitUntil: "load" }), update.click()]);
		await expect(region).toHaveValue("CA");
		await expect(page.locator("#delivery-error")).toHaveCount(0);
		const option = delivery.locator('input[name="deliveryMethod"]:not([disabled])');
		await expect(option.first()).toBeVisible();
		if (!(await option.first().isChecked())) {
			await option.first().check();
			await Promise.all([page.waitForURL(/method=/, { waitUntil: "load" }), update.click()]);
		}
		await expect(page.getByText(/Delivering to United States, California/)).toBeVisible();

		// ── Place ──────────────────────────────────────────────────────────────
		const form = page.locator("form#checkout-place");
		await form.locator('input[name="email"]').fill(`zoned-${Date.now()}@example.test`);
		await form.locator('input[name="name"]').fill("Cal Buyer");
		await form.locator('input[name="line1"]').fill("1 Market St");
		await form.locator('input[name="city"]').fill("San Francisco");
		await form.locator('input[name="postalCode"]').fill("94105");
		const submit = form.locator('button[type="submit"]:not([value])');
		if ((await submit.count()) === 0) {
			await skipWithoutPlaceButton(testInfo, "no Continue to payment button");
		}
		await Promise.all([
			page.waitForURL((url) => url.pathname !== "/checkout", { waitUntil: "load" }),
			submit.click(),
		]);
		expect(new URL(page.url()).pathname, `landed on ${page.url()}`).toBe("/checkout/pay");
	});
});
