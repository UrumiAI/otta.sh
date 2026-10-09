/**
 * The state/province pick list on a store whose ONLY region-level rule is a
 * state TAX rate, in a real browser with JavaScript OFF.
 *
 * Tax rates hang on zones (ADR-0021), so "a state-level tax rate" is a zone
 * listing `US-CA` that carries a tax rate and no shipping method. The store
 * therefore uses regions for the US: choosing the US alone is refused for its
 * state, the state list is shown and marked, and California is accepted — the
 * review then states the destination. (The zone
 * offers no delivery method, so this store cannot take a physical order there:
 * that is the store's configuration, and the page says so.)
 *
 * It puts the store back afterwards: the rate, the class and the zone it
 * creates through the plugin's admin route are deleted.
 */
import {
	addOneToCart,
	admin,
	adminHeaders,
	everything,
	formBlockId,
	pathToken,
} from "./admin-rules.js";
import { expect, skipWithoutPurchasableProduct, skipWithoutSite, test } from "./harness.js";

const ZONE = "e2e-tax-us-ca";
const CLASS = "e2e-tax-std";
const RATE = "e2e-tax-ca";

test.use({ javaScriptEnabled: false });

test.describe("the state/province pick list on a store with only a state-level tax rate (no client JS)", () => {
	let headers: Record<string, string> = {};

	test.afterAll(async () => {
		if (headers["Cookie"] === undefined) return;
		await admin(headers, {
			type: "block_action",
			action_id: "tax:delete-rate",
			value: { classId: CLASS, rateId: RATE },
		});
		await admin(headers, {
			type: "block_action",
			action_id: "tax:delete-class",
			value: { classId: CLASS },
		});
		const blocks = await admin(headers, {
			type: "block_action",
			action_id: "shipping:delete-zone",
			value: { zoneId: ZONE },
		});
		expect(JSON.stringify(blocks)).not.toContain(`ship:zone:${ZONE}`);
	});

	test("US is refused for its state, the list is shown and marked, California is accepted", async ({
		page,
	}, testInfo) => {
		await skipWithoutSite(testInfo);

		// ── The rule: a US-CA zone carrying a 7.25% rate, no shipping method ──
		headers = await adminHeaders();
		await admin(headers, {
			type: "form_submit",
			action_id: "shipping:create-zone",
			values: { id: ZONE, name: "California (tax)", regions: "US-CA", ackFirstZone: true },
		});
		const classes = await admin(headers, { type: "page_load", page: "/tax" });
		const newClass = everything(classes).find((b) => b["action_id"] === "tax:show-new-class");
		const classScreen = await admin(headers, {
			type: "block_action",
			action_id: "tax:show-new-class",
			value: newClass?.["value"],
		});
		await admin(headers, {
			type: "form_submit",
			action_id: "tax:create-class",
			values: { id: CLASS, name: "E2E standard" },
			block_id: formBlockId(classScreen, "tax:create-class"),
		});
		const rates = await admin(headers, {
			type: "block_action",
			action_id: "tax:open",
			value: { target: pathToken([CLASS]) },
		});
		const newRate = everything(rates).find((b) => b["action_id"] === "tax:show-new-rate");
		const rateScreen = await admin(headers, {
			type: "block_action",
			action_id: "tax:show-new-rate",
			value: newRate?.["value"],
		});
		const created = await admin(headers, {
			type: "form_submit",
			action_id: "tax:create-rate",
			values: { id: RATE, zoneId: ZONE, ratePercent: "7.25", appliesToShipping: false },
			block_id: formBlockId(rateScreen, "tax:create-rate"),
		});
		expect(JSON.stringify(created), "the CA tax rate was not created").toContain(RATE);

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

		// ── US alone: refused for its STATE, list shown and marked ───────────────
		await page.goto("/checkout");
		const delivery = page.locator("#delivery");
		const country = delivery.locator('select[name="deliveryCountry"]');
		const update = delivery.locator('button[value="update-delivery"]');
		await country.selectOption("US");
		await Promise.all([page.waitForURL(/country=US/, { waitUntil: "load" }), update.click()]);
		await expect(country).toHaveValue("US");
		// The state is what was refused — not the country.
		await expect(country).not.toHaveAttribute("aria-invalid", "true");
		const region = delivery.locator('select[name="deliveryRegion"]');
		await expect(region).toHaveAttribute("aria-invalid", "true");
		await expect(page.locator("#delivery-error")).toContainText(/state\/province/i);

		// ── California: accepted and stated ─────────────────────────────────────
		await region.selectOption("CA");
		await Promise.all([page.waitForURL(/region=CA/, { waitUntil: "load" }), update.click()]);
		await expect(region).toHaveValue("CA");
		await expect(region).not.toHaveAttribute("aria-invalid", "true");
		await expect(page.locator("#delivery-error")).toHaveCount(0);
		await expect(page.getByText(/Delivering to United States, California/)).toBeVisible();
		await expect(
			page.getByText(/There are no delivery options for this address/).first(),
		).toBeVisible();
	});

	test.describe("with JavaScript (ADR-0034)", () => {
		test.use({ javaScriptEnabled: true });

		test("no country is preselected where the store ships nowhere; the list follows the country at once", async ({
			page,
		}, testInfo) => {
			await skipWithoutSite(testInfo);
			await page.route(/js\.stripe\.com/, (route) => route.abort());
			await addOneToCart(page, () => skipWithoutPurchasableProduct(testInfo));
			await page.goto("/checkout");
			const delivery = page.locator("#delivery");
			const country = delivery.locator('select[name="deliveryCountry"]');
			const region = delivery.locator('select[name="deliveryRegion"]');
			const update = delivery.locator('button[value="update-delivery"]');
			// A store that ships nowhere (its only zone carries a tax rate, no
			// method) never preselects a country — not even its tax zone's.
			await expect(country).toHaveValue("");
			await expect(region).toBeHidden();
			const before = page.url();
			await country.selectOption("US");
			await expect(region.locator('option[value="CA"]')).toHaveText("California");
			await country.selectOption("IN");
			await expect(region.locator('option[value="KA"]')).toHaveText("Karnataka");
			await expect(region.locator('option[value="CA"]')).toHaveCount(0);
			await country.selectOption("US");
			await expect(region.locator('option[value="CA"]')).toHaveText("California");
			expect(page.url(), "the list swapped without a navigation").toBe(before);
			await region.selectOption("CA");
			await Promise.all([page.waitForURL(/region=CA/, { waitUntil: "load" }), update.click()]);
			await expect(region).toHaveValue("CA");
			await expect(page.getByText(/Delivering to United States, California/)).toBeVisible();
		});
	});
});
