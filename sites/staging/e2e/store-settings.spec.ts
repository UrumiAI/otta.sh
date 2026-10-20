/**
 * Store settings hosts the Settings, Tax and Shipping screens as tabs. EmDash
 * replaces the page's whole block tree on every response, so the claim worth a
 * browser is the one the unit tests can only infer from a stable `block_id`: an
 * action inside a tab answers with the tabs intact and the SAME tab selected.
 */
import { OTTA_PLUGIN_ID, STORE_SETTINGS_PAGE } from "@urumi.ai/otta-plugin";
import {
	ADMIN_BASE_PATH,
	ADMIN_SHELL_TIMEOUT_MS,
	dismissWelcomeDialog,
	expect,
	test,
} from "./harness.js";

test.describe("Store settings", () => {
	test.slow();

	test("an action in the Tax tab keeps the Tax tab selected", async ({ adminPage }) => {
		await adminPage.goto(`${ADMIN_BASE_PATH}/plugins/${OTTA_PLUGIN_ID}${STORE_SETTINGS_PAGE.path}`);
		await expect(adminPage.getByRole("tab", { name: "General" })).toBeVisible({
			timeout: ADMIN_SHELL_TIMEOUT_MS,
		});
		await dismissWelcomeDialog(adminPage);

		await adminPage.getByRole("tab", { name: "Tax" }).click();
		await expect(
			adminPage.getByRole("heading", { name: "Tax classes", exact: true }),
		).toBeVisible();
		await adminPage
			.getByRole("button", { name: /New tax class/ })
			.first()
			.click();

		await expect(
			adminPage.getByRole("heading", { name: "New tax class", exact: true }),
		).toBeVisible();
		await expect(adminPage.getByRole("tab", { name: "Tax", selected: true })).toBeVisible();
		await expect(adminPage.getByRole("tab", { name: "General" })).toBeVisible();
		await expect(adminPage.getByRole("tab", { name: "Shipping" })).toBeVisible();
	});
});
