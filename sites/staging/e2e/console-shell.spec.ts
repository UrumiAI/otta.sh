/**
 * THE TWO-DESCRIPTOR GATE — the proof that a React page in this admin does not
 * cost the Block Kit screens their sidebar.
 *
 * Sidebar visibility is derived PER PLUGIN ID: one `adminMode` per plugin,
 * `"react"` the moment `admin.entry` exists, after which the sidebar shows only
 * that plugin's pages having a React component. One React page added under id
 * `otta` would therefore make its Block Kit screens VANISH from the sidebar
 * while they all kept rendering at their URLs — nothing throws, nothing 404s,
 * and the only symptom is an empty nav group. That is ADR-0014 Decision 7's
 * `adminMode` granularity trap, it is the central risk of the whole
 * arrangement, and it is invisible to every unit test and to all of the
 * browser-blind sandbox suites (ADR-0006 Decision 1). This file is the only
 * automated evidence that the arrangement holds.
 *
 * IT USED TO LIVE ON THE CONSOLE SHELL, AND THAT WAS AN ACCIDENT OF TIMING.
 * INC-19's `/console` landing page was the first React page to exist, so the
 * assertion was written where it could first be made. ADR-0015 removed that
 * page — it managed no data — and the assertion was RE-HOMED here rather than
 * deleted, onto `/orders`, a console page that manages a great deal. Nothing
 * about it was weakened in the move: the Block Kit group is still counted AND
 * named, the console's own group is still required beside it, and the sidebar
 * screenshot is still captured on a passing run.
 *
 * Separate from `console-screens.spec.ts` on purpose. That file generates one
 * smoke spec per entry in `MIGRATED_SCREENS` and asserts, per screen, that the
 * Block Kit group is merely PRESENT. The whole-inventory assertion — every
 * declared Block Kit page, by name, in one place — is this file's, and keeping
 * it out of the generator means it is made once rather than once per migration.
 */
import type { Page } from "@playwright/test";
import {
	COUPONS_PAGE,
	REPORTS_PAGE,
	SETTINGS_PAGE,
	SHIPPING_PAGE,
	TAX_PAGE,
} from "@otta-sh/plugin";
import type { ConsoleScreen } from "./harness.js";
import {
	ADMIN_BASE_PATH,
	ADMIN_SHELL_TIMEOUT_MS,
	BLOCK_KIT_SIDEBAR_LINK,
	MIGRATED_SCREENS,
	REPO_ROOT,
	consoleScreenUrl,
	dismissWelcomeDialog,
	expect,
	test,
} from "./harness.js";

/** Written at the outputDir ROOT rather than under the per-test directory:
 *  `preserveOutput: "failures-only"` sweeps the latter on a pass, and this shot
 *  is required evidence for a PASSING run. Playwright clears outputDir at the
 *  start of the NEXT run, so it survives exactly as long as it is useful. The
 *  1440x2200 viewport comes from the project config; nothing here passes
 *  `fullPage`, which truncates these pages. */
const SHELL_SHOT = `${REPO_ROOT}/node_modules/.playwright-artifacts/console-shell-1440x2200.png`;

/**
 * The console page this gate is driven from — READ OUT OF THE REGISTRY, not
 * redeclared. The registry is where a console screen is written down on the test
 * side, and a second literal here would be a second inventory that can drift
 * from it silently. The lookup throws rather than falling back: this file's
 * assertions are meaningless without a real console page to make them on, and a
 * skipped gate is worse than a failing one.
 */
function hostScreen(): ConsoleScreen {
	const screen = MIGRATED_SCREENS.find((entry) => entry.path === "/orders");
	if (screen === undefined) {
		throw new Error(
			"the two-descriptor gate is homed on the console's /orders screen, which is no longer in " +
				"MIGRATED_SCREENS — re-home this spec onto another console page rather than deleting it",
		);
	}
	return screen;
}

const HOST_SCREEN = hostScreen();

/**
 * The Block Kit screens that must survive the console's presence — taken from
 * `@otta-sh/plugin`'s own exports, which are the same constants
 * `ottaPluginDescriptor` registers. `site-config.test.ts` pins the descriptor's
 * `adminPages` to exactly this list, so the two cannot drift.
 */
const BLOCK_KIT_PAGES = [
	REPORTS_PAGE,
	SETTINGS_PAGE,
	TAX_PAGE,
	SHIPPING_PAGE,
	COUPONS_PAGE,
] as const;

/**
 * Open the host screen and wait for the admin SPA to hand it to React.
 *
 * Every spec below starts here, and the wait is the reason the helper exists:
 * until the shell boots, the whole document is the string "Loading EmDash…" and
 * the plugin page does not exist in the DOM. See `ADMIN_SHELL_TIMEOUT_MS`.
 */
async function openHostScreen(page: Page): Promise<void> {
	await page.goto(consoleScreenUrl(HOST_SCREEN.path));
	// The heading ROLE — see `console-screens.spec.ts` for why a text match on
	// this screen's name is satisfied by the sidebar link as well as the H1.
	await expect(page.getByRole("heading", { name: HOST_SCREEN.heading }).first()).toBeVisible({
		timeout: ADMIN_SHELL_TIMEOUT_MS,
	});
}

// The admin shell's boot dominates every spec here; the per-test default of 60s
// leaves too little after it for the assertions that follow.
test.describe("the otta-console React descriptor", () => {
	test.slow();

	test("renders under otta-console and reaches otta's admin route", async ({ adminPage }) => {
		// THE CROSS-DESCRIPTOR CALL, observed as the PAGE issues it. INC-19's
		// shell printed the status of this call into the DOM and the spec read it
		// back; with the shell gone the same evidence comes off the network, which
		// is strictly closer to the fact being asserted. It is not re-issued with
		// the test's own headers — the session cookie and the `X-EmDash-Request`
		// CSRF header have to be the page's, or the assertion proves something
		// else entirely.
		//
		// ADR-0014 Decision 3: this page is served under `otta-console`, holds no
		// capabilities and owns no routes, and reaches commerce ONLY by POSTing to
		// the `otta` plugin's admin route — a route belonging to a DIFFERENT
		// plugin id — with the operator's own session. A 401/403 here is that
		// arrangement failing.
		//
		// The status, NOT the payload. Whether the commerce service behind the
		// plugin is reachable and configured is the screen's own gate
		// (`orders-console.spec.ts`); tying THIS spec to it would make the
		// two-descriptor evidence fail for reasons that have nothing to do with
		// the two descriptors.
		// ATTRIBUTION IS BY CONTEXT, NOT BY CALLER. The listener matches any
		// response on that path in this page's context, and takes it as the
		// console's. That holds because the only thing rendering under this URL is
		// the React screen — no Block Kit page renders here, and the admin shell
		// itself does not call a plugin's admin route. What would invalidate it: an
		// admin shell (or another extension loaded alongside this page) issuing its
		// own POST to `otta`'s admin route. Then the "it happened at all" poll below
		// could be satisfied without the console having called, and this would need
		// to attribute the call properly — by correlating the request body's
		// `resource`, or by driving the page and awaiting the response it triggers.
		const adminRouteStatuses: number[] = [];
		adminPage.on("response", (res) => {
			if (new URL(res.url()).pathname === "/_emdash/api/plugins/otta/admin") {
				adminRouteStatuses.push(res.status());
			}
		});

		const response = await adminPage.goto(consoleScreenUrl(HOST_SCREEN.path));

		// G5's reason transfers to the React tier for a different mechanism: a
		// non-2xx here is an unmounted screen, not a banner.
		expect(response?.status(), `${HOST_SCREEN.path} did not return 2xx`).toBeLessThan(300);
		await expect(adminPage.getByRole("heading", { name: HOST_SCREEN.heading }).first()).toBeVisible(
			{ timeout: ADMIN_SHELL_TIMEOUT_MS },
		);

		// It happened at all — a screen that never called would satisfy an
		// "every call was 200" check vacuously...
		await expect
			.poll(() => adminRouteStatuses.length, {
				message: "the console never called the `otta` plugin's admin route",
			})
			.toBeGreaterThan(0);
		// ...and every one of them was accepted.
		expect(adminRouteStatuses, "a cross-descriptor admin call was refused").toEqual(
			adminRouteStatuses.map(() => 200),
		);
	});

	test("does NOT hide the Block Kit plugin's screens from the sidebar", async ({ adminPage }) => {
		await openHostScreen(adminPage);

		// THE WHOLE REASON FOR THE SECOND DESCRIPTOR ID. See the module doc: a
		// React page under id `otta` flips that plugin's adminMode to "react",
		// after which the sidebar shows only its pages having a React component —
		// i.e. none of these — while they all keep rendering at their URLs.
		const blockKitLinks = adminPage.locator(BLOCK_KIT_SIDEBAR_LINK);
		await expect(blockKitLinks.first()).toBeVisible();

		// The expectation is DERIVED from the plugin's own exported page list, not
		// the literal count this first read. A hard-coded count is a second place the
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

		// ...and BOTH GROUPS ARE PRESENT AT ONCE, which is the claim. Every console
		// page has its own entry under the console's own id, beside the Block Kit
		// ones above rather than instead of them.
		for (const screen of MIGRATED_SCREENS) {
			await expect(
				adminPage.locator(`a[href*="${consoleScreenUrl(screen.path)}"]`).first(),
				`the console's ${screen.name} entry is missing from the sidebar`,
			).toBeVisible();
		}
	});

	test("captures the sidebar showing BOTH groups", async ({ adminPage }, testInfo) => {
		await openHostScreen(adminPage);
		// Settle the screen's own read first — a shot of a half-loaded page is
		// evidence of nothing.
		await expect(adminPage.getByTestId("orders-intro")).toBeVisible();
		// ...and get the first-login modal out of the frame; it covers half the
		// viewport and none of what this shot exists to show.
		await dismissWelcomeDialog(adminPage);
		await adminPage.screenshot({ path: SHELL_SHOT });
		await testInfo.attach("console-shell-1440x2200", {
			path: SHELL_SHOT,
			contentType: "image/png",
		});
	});
});
