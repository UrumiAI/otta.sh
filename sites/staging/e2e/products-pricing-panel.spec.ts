/**
 * Pricing & stock inside the products collection's own screens, in a real
 * browser (ADR-0014, amendment 2026-10-01).
 *
 * The unit tiers prove the panel's decisions and wiring against a mocked route
 * (`packages/admin-react/test/pricing-*.test.tsx`) and the route itself in the
 * workerd sandbox (`products-console-route.sandbox.test.ts`). What only a
 * browser can prove is that EMDASH DISCOVERS THEM: that the admin module's
 * `fields.pricing` editor and `contentListColumns` exports reach a saved
 * product's editor (main column) and the collection list, and that the sidebar no longer offers a
 * Pricing & inventory page.
 *
 * IT WRITES. It prices and restocks the first product on the list, so point it
 * only at a local, seeded stack (DIRECTOR-SPEC §0.2).
 */
import type { Page } from "@playwright/test";
import {
	ADMIN_BASE_PATH,
	ADMIN_SHELL_TIMEOUT_MS,
	dismissWelcomeDialog,
	expect,
	skipWithoutProducts,
	test,
} from "./harness.js";

const LIST_URL = `${ADMIN_BASE_PATH}/content/products`;

async function openList(page: Page): Promise<void> {
	await page.goto(LIST_URL);
	// On a fresh database EmDash greets the first admin with a modal that opens
	// a moment AFTER the shell boots, and hides the list from the accessibility
	// tree while it is up. Wait for whichever comes first, then clear it.
	const price = page.getByRole("columnheader", { name: "Price" });
	const greeting = page.getByRole("dialog", { name: /Welcome to EmDash/i });
	await expect(price.or(greeting)).toBeVisible({ timeout: ADMIN_SHELL_TIMEOUT_MS });
	await dismissWelcomeDialog(page);
	await expect(price).toBeVisible({ timeout: ADMIN_SHELL_TIMEOUT_MS });
}

test.describe("pricing and stock live in the products collection", () => {
	test("the sidebar offers no Pricing & inventory page", async ({ adminPage }) => {
		await openList(adminPage);
		await expect(adminPage.getByRole("link", { name: "Pricing & inventory" })).toHaveCount(0);
		await expect(adminPage.locator(`a[href$="/plugins/otta-console/products"]`)).toHaveCount(0);
	});

	test("the products list shows each product's price and stock", async ({ adminPage }, info) => {
		await openList(adminPage);
		await expect(adminPage.getByRole("columnheader", { name: "Stock" })).toBeVisible();
		const rows = adminPage.locator("tbody tr");
		await skipWithoutProducts(info, await rows.count());
		// Every cell settles to a value — a price or "Not priced", a count or a
		// reason — never stays on the loading mark.
		await expect(adminPage.locator(".otta-pricing-cell").first()).toBeVisible();
		await expect(adminPage.locator(".otta-pricing-cell", { hasText: "…" })).toHaveCount(0, {
			timeout: 15_000,
		});
		await info.attach("products-list", {
			body: await adminPage.screenshot({ fullPage: true }),
			contentType: "image/png",
		});
	});

	test("a saved product's editor shows the Pricing & stock cards in its main column, and they save and restock", async ({
		adminPage,
	}, info) => {
		await openList(adminPage);
		const rows = adminPage.locator("tbody tr");
		await skipWithoutProducts(info, await rows.count());
		await rows.first().getByRole("link").first().click();

		const panel = adminPage.getByTestId("otta-pricing-panel");
		await expect(panel).toBeVisible({ timeout: ADMIN_SHELL_TIMEOUT_MS });
		await expect(panel.getByRole("heading", { name: "Pricing", exact: true })).toBeVisible();
		await expect(panel.getByRole("heading", { name: "Inventory" })).toBeVisible();
		// In the MAIN column, not the settings sidebar.
		await expect(
			adminPage.getByRole("complementary").getByTestId("otta-pricing-panel"),
		).toHaveCount(0);

		// One Save: a new price, then the panel re-reads and settles.
		const price = panel.getByLabel("Price", { exact: true });
		const next = (await price.inputValue()) === "27.00" ? "28.00" : "27.00";
		await price.fill(next);
		await expect(panel.getByText(/Not saved yet/)).toBeVisible();
		await panel.getByRole("button", { name: "Save pricing & stock" }).click();
		await expect(panel.getByText("Saved", { exact: true })).toBeVisible();
		await expect(price).toHaveValue(next);

		// Stock is its own button, one click to add.
		const count = panel.getByTestId("otta-on-hand");
		if ((await count.count()) > 0) {
			const before = Number(await count.textContent());
			await panel.getByLabel("Add or remove stock").fill("2");
			await panel.getByRole("button", { name: "+ Add" }).click();
			await expect(count).toHaveText(String(before + 2));
		}
		await info.attach("pricing-panel", {
			body: await adminPage.screenshot({ fullPage: true }),
			contentType: "image/png",
		});
	});
});
