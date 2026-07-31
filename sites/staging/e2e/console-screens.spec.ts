/**
 * One smoke spec per migrated React screen — generated from `MIGRATED_SCREENS`
 * so the registry and the coverage are the same object. A screen cannot be
 * migrated and left ungated: the entry that puts it in the console is the entry
 * that puts it under Playwright.
 *
 * The file is deliberately EMPTY of tests at INC-18. Nothing is migrated yet;
 * INC-20 brings Orders and INC-21 brings Pricing & inventory, and each arrives
 * as one line in the registry. The Block Kit screens keep their own gate — the
 * 18 workerd sandbox suites — until the increment that replaces them, screen by
 * screen (ADR-0014, reaffirming ADR-0006 Decision 1).
 *
 * Because it generates nothing yet, the console URL prefix and the sidebar
 * selector are the one part of this increment no run can have exercised. Both
 * are DEFINED in `harness.ts` (`ADMIN_BASE_PATH` / `consoleScreenUrl` and
 * `BLOCK_KIT_SIDEBAR_LINK`) and re-pinned as a literal in `harness.spec.ts`'s
 * "console screens are addressed under the second descriptor id" test. INC-19
 * loads the first real console page; if EmDash's admin router disagrees, those
 * are the two files to edit — this one consumes them and needs no change.
 */
import {
	BLOCK_KIT_SIDEBAR_LINK,
	MIGRATED_SCREENS,
	consoleScreenUrl,
	expect,
	test,
} from "./harness.js";

for (const screen of MIGRATED_SCREENS) {
	// `adminPage` carries the skip: it probes the site before signing in, so a
	// run with no stack skips here instead of failing in fixture setup.
	test(`${screen.name} (${screen.increment}) renders under otta-console`, async ({ adminPage }) => {
		const response = await adminPage.goto(consoleScreenUrl(screen.path));

		// G5's reason applies to the React tier too, for a different mechanism:
		// a non-2xx here is an unmounted screen, not a banner.
		expect(response?.status(), `${screen.path} did not return 2xx`).toBeLessThan(300);
		await expect(adminPage.getByText(screen.heading).first()).toBeVisible();

		// The sidebar must still show the `otta` Block Kit group. Two descriptors
		// exist precisely so a React page cannot hide the six screens that stay
		// on Block Kit (the `adminMode` granularity trap, ADR-0014 Decision 7);
		// this is the assertion that would catch the two collapsing into one id.
		// The selector lives in harness.ts so it and the URL builder move together.
		await expect(adminPage.locator(BLOCK_KIT_SIDEBAR_LINK).first()).toBeVisible();
	});
}
