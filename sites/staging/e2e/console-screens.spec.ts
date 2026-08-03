/**
 * One smoke spec per migrated React screen — generated from `MIGRATED_SCREENS`
 * so the registry and the coverage are the same object. A screen cannot be
 * migrated and left ungated: the entry that puts it in the console is the entry
 * that puts it under Playwright.
 *
 * It was deliberately EMPTY of tests at INC-18 and INC-19, because nothing had
 * been migrated. INC-20 brings Orders and INC-21 brings Pricing & inventory,
 * and each arrives as one line in the registry. The Block Kit screens keep
 * their own gate — the 18 workerd sandbox suites — until the increment that
 * replaces them, screen by screen (ADR-0014, reaffirming ADR-0006 Decision 1).
 *
 * INC-19's note here said this file "consumes them and needs no change". That
 * held for the URL prefix and the sidebar selector, which are still defined in
 * `harness.ts` and re-pinned in `harness.spec.ts`. It did NOT hold for the
 * TIMEOUT, and INC-20 found out the only way an untested generator can be found
 * out — by generating its first spec and watching it fail.
 *
 * WHAT WAS WRONG. The first assertion after a full page load has to outwait the
 * admin SPA's boot: until it finishes, the entire document is the string
 * "Loading EmDash…" and no plugin page exists in the DOM at all. That boot is
 * measured at roughly 5-25 seconds against `astro dev` on this box —
 * `ADMIN_SHELL_TIMEOUT_MS` exists for exactly this, `two-descriptor-gate.spec.ts`
 * passes it on every first assertion, and this file did not, so the generated
 * Orders spec raced a 10-second default and failed with "element(s) not found"
 * — which reads like a broken selector and is not one. The wait is sized to a
 * known-slow bundle, NOT a weakened assertion: it still fails if the page never
 * renders.
 */
import {
	ADMIN_SHELL_TIMEOUT_MS,
	BLOCK_KIT_SIDEBAR_LINK,
	MIGRATED_SCREENS,
	consoleScreenUrl,
	expect,
	test,
} from "./harness.js";

// The admin shell's boot dominates every spec generated here; the per-test
// default leaves too little after it for the assertions that follow.
test.describe.configure({ mode: "default", timeout: 120_000 });

for (const screen of MIGRATED_SCREENS) {
	// `adminPage` carries the skip: it probes the site before signing in, so a
	// run with no stack skips here instead of failing in fixture setup.
	test(`${screen.name} (${screen.increment}) renders under otta-console`, async ({ adminPage }) => {
		const response = await adminPage.goto(consoleScreenUrl(screen.path));

		// G5's reason applies to the React tier too, for a different mechanism:
		// a non-2xx here is an unmounted screen, not a banner.
		expect(response?.status(), `${screen.path} did not return 2xx`).toBeLessThan(300);
		// THE HEADING ROLE, NOT THE TEXT. A bare text match is satisfied by any
		// element carrying the string, and on `/orders` three do — the sidebar
		// link, the H1 and the table caption — so `.first()` was resolving to the
		// SIDEBAR and this assertion passed whether or not the screen rendered.
		// The screen's H1 is the only heading with that accessible name, and it is
		// the fact this spec exists to state.
		await expect(adminPage.getByRole("heading", { name: screen.heading }).first()).toBeVisible({
			timeout: ADMIN_SHELL_TIMEOUT_MS,
		});

		// The sidebar must still show the `otta` Block Kit group. Two descriptors
		// exist precisely so a React page cannot hide the five screens that stay
		// on Block Kit (the `adminMode` granularity trap, ADR-0014 Decision 7);
		// this is the assertion that would catch the two collapsing into one id.
		// The selector lives in harness.ts so it and the URL builder move together.
		await expect(adminPage.locator(BLOCK_KIT_SIDEBAR_LINK).first()).toBeVisible();
	});
}
