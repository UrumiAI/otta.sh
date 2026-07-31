/**
 * The console shell's gate — INC-19's replacement for a sandbox suite.
 *
 * The 18 `packages/plugin/test/*.sandbox.test.ts` suites are browser-blind and
 * cannot see a React page (ADR-0014, reaffirming ADR-0006 Decision 1), so this
 * is the only thing standing between the shell and a regression. It asserts the
 * three facts INC-19 exists to establish, and no more:
 *
 *   1. A `format: "native"` descriptor renders a React page in the EmDash admin.
 *   2. Registering it did NOT hide the `otta` plugin's seven Block Kit screens
 *      — the `adminMode` granularity trap (ADR-0014 Decision 7), which is the
 *      entire reason there are two descriptor ids and the one failure mode a
 *      unit test cannot see.
 *   3. `POST /_emdash/api/plugins/otta/admin`, called from a page served under
 *      a DIFFERENT plugin id, answers 200 (ADR-0014 Decision 3's only data
 *      path).
 *
 * Separate from `console-screens.spec.ts` on purpose: that file generates one
 * spec per MIGRATED screen from `MIGRATED_SCREENS`, and the shell is not a
 * migration — no Block Kit screen was replaced by it. See the registry's own
 * note in `harness.ts`.
 */
import type { Page } from "@playwright/test";
import {
	COUPONS_PAGE,
	ORDERS_PAGE,
	PRODUCTS_PAGE,
	REPORTS_PAGE,
	SETTINGS_PAGE,
	SHIPPING_PAGE,
	TAX_PAGE,
} from "@otta-sh/plugin";
import {
	ADMIN_BASE_PATH,
	ADMIN_SHELL_TIMEOUT_MS,
	BLOCK_KIT_SIDEBAR_LINK,
	CONSOLE_SHELL,
	MIGRATED_SCREENS,
	REPO_ROOT,
	consoleScreenUrl,
	dismissWelcomeDialog,
	expect,
	test,
} from "./harness.js";

/** Written at the outputDir ROOT rather than under the per-test directory:
 *  `preserveOutput: "failures-only"` sweeps the latter on a pass, and this shot
 *  is required evidence for a PASSING run (DIRECTOR-SPEC §4). Playwright clears
 *  outputDir at the start of the NEXT run, so it survives exactly as long as it
 *  is useful. §0.4's 1440x2200 viewport comes from the project config; nothing
 *  here passes `fullPage`, which truncates these pages. */
const SHELL_SHOT = `${REPO_ROOT}/node_modules/.playwright-artifacts/console-shell-1440x2200.png`;

/**
 * The Block Kit screens that must survive the console's arrival — taken from
 * `@otta-sh/plugin`'s own exports, which are the same constants
 * `ottaPluginDescriptor` registers. `site-config.test.ts` pins the descriptor's
 * `adminPages` to exactly this list, so the two cannot drift.
 */
const BLOCK_KIT_PAGES = [
	REPORTS_PAGE,
	SETTINGS_PAGE,
	ORDERS_PAGE,
	PRODUCTS_PAGE,
	TAX_PAGE,
	SHIPPING_PAGE,
	COUPONS_PAGE,
] as const;

/**
 * Open the shell and wait for the admin SPA to hand it to React.
 *
 * Every spec below starts here, and the wait is the reason the helper exists:
 * until the shell boots, the whole document is the string "Loading EmDash…" and
 * the plugin page does not exist in the DOM. See `ADMIN_SHELL_TIMEOUT_MS`.
 */
async function openConsoleShell(page: Page): Promise<void> {
	await page.goto(consoleScreenUrl(CONSOLE_SHELL.path));
	await expect(page.getByText(CONSOLE_SHELL.heading).first()).toBeVisible({
		timeout: ADMIN_SHELL_TIMEOUT_MS,
	});
}

// The admin shell's boot dominates every spec here; the per-test default of 60s
// leaves too little after it for the assertions that follow.
test.describe("the otta-console shell", () => {
	test.slow();

	test("renders under otta-console and reaches otta's admin route", async ({ adminPage }) => {
		const response = await adminPage.goto(consoleScreenUrl(CONSOLE_SHELL.path));

		// G5's reason transfers to the React tier for a different mechanism: a
		// non-2xx here is an unmounted screen, not a banner.
		expect(response?.status(), `${CONSOLE_SHELL.path} did not return 2xx`).toBeLessThan(300);
		await expect(adminPage.getByText(CONSOLE_SHELL.heading).first()).toBeVisible({
			timeout: ADMIN_SHELL_TIMEOUT_MS,
		});

		// FACT 3. The page performs the cross-descriptor call on mount and renders
		// the literal outcome, so this reads the result rather than re-issuing the
		// request with the test's own headers — the CSRF header and the session
		// cookie have to be the page's, or the assertion proves something else.
		await expect(adminPage.getByTestId("probe-result")).toHaveText(/HTTP 200 in \d+ ms/);
	});

	test("does NOT hide the Block Kit plugin's screens from the sidebar", async ({ adminPage }) => {
		await openConsoleShell(adminPage);

		// FACT 2, the whole reason for the second descriptor id. Sidebar
		// visibility is derived PER PLUGIN ID: a React page added under id `otta`
		// flips that plugin's adminMode to "react", after which the sidebar shows
		// only its pages having a React component — i.e. none of the seven — while
		// they all keep rendering at their URLs. Nothing throws, nothing 404s, and
		// the only symptom is an empty nav group.
		const blockKitLinks = adminPage.locator(BLOCK_KIT_SIDEBAR_LINK);
		await expect(blockKitLinks.first()).toBeVisible();

		// The expectation is DERIVED from the plugin's own exported page list, not
		// the literal 7 this first read. A hard-coded count is a second place the
		// screen inventory is written down, and the wrong one wins: an increment
		// that legitimately adds a Block Kit page would fail here and the obvious
		// fix — bump the number — is indistinguishable from the obvious fix for
		// the bug this test exists to catch. Deriving it means the test tracks the
		// plugin and only fires when the SIDEBAR disagrees with it.
		expect(
			await blockKitLinks.count(),
			"the otta plugin's sidebar entries do not match its declared adminPages",
		).toBe(BLOCK_KIT_PAGES.length);

		// Named, not just counted — an equal-sized but different set is still the
		// failure. (`href` carries `adminPages[].path` verbatim.)
		for (const page of BLOCK_KIT_PAGES) {
			await expect(
				adminPage.locator(`a[href$="${ADMIN_BASE_PATH}/plugins/otta${page.path}"]`).first(),
				`${page.label} is missing from the sidebar`,
			).toBeVisible();
		}

		// ...and the console's own entry is there, under its own id.
		await expect(
			adminPage.locator(`a[href*="${consoleScreenUrl(CONSOLE_SHELL.path)}"]`).first(),
		).toBeVisible();
	});

	test("captures the sidebar showing BOTH groups", async ({ adminPage }, testInfo) => {
		await openConsoleShell(adminPage);
		// Settle the probe first — a shot of "checking…" is evidence of nothing.
		await expect(adminPage.getByTestId("probe-result")).toHaveText(/HTTP \d+/);
		// ...and get the first-login modal out of the frame; it covers half the
		// viewport and none of what this shot exists to show.
		await dismissWelcomeDialog(adminPage);
		await adminPage.screenshot({ path: SHELL_SHOT });
		await testInfo.attach("console-shell-1440x2200", {
			path: SHELL_SHOT,
			contentType: "image/png",
		});
	});

	test("the shell is not counted as a migrated screen", () => {
		// A cheap, server-free pin on the boundary the registry's doc comment
		// draws. If a later increment moves the shell into MIGRATED_SCREENS, the
		// registry stops answering "how many Block Kit screens have been
		// replaced" — which is the question ADR-0014 Decision 6 is scoped in.
		expect(MIGRATED_SCREENS.map((screen) => screen.path)).not.toContain(CONSOLE_SHELL.path);
		expect(CONSOLE_SHELL.increment).toBe("INC-19");
	});
});
