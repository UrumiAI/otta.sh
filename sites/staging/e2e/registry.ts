/**
 * WHICH REACT SCREENS EXIST, AND WHICH MAY — plain data, and nothing else.
 *
 * WHY THIS IS ITS OWN MODULE. This registry is the coverage gate for the React
 * console, and two different runners need to read it: Playwright, which
 * generates a smoke spec per entry, and vitest, where `site-config.test.ts`
 * asserts that every page the console SERVES appears here (otherwise a screen
 * can be migrated with no gate at all and every check still goes green).
 *
 * It used to live in `harness.ts`, and the vitest side imported it from there.
 * That was wrong in two ways at once, both of which this split fixes:
 *
 *  1. **`harness.ts` runs side effects at import.** It resolves and
 *     loopback-guards `OTTA_E2E_BASE_URL`, `COMMERCE_SERVICE_URL` and
 *     `PG_CONNECTION_STRING` at module load — deliberately, because an
 *     inherited export must not aim an e2e run at production. But
 *     `COMMERCE_SERVICE_URL` is also the staging site's ordinary BUILD-time
 *     variable (`sites/staging/README.md`), so
 *     `COMMERCE_SERVICE_URL=https://svc.example.com pnpm vitest --project
 *     site-staging` — a completely reasonable thing to run — made the UNIT
 *     suite throw before a single assertion, on a guard written for a runner it
 *     was not using. Reproduced, then fixed here.
 *  2. **It pulls in `@playwright/test`,** which `sites/staging` does not
 *     declare. The unit run resolved it only by walking up to the root's
 *     devDependency — an undeclared dependency working by accident of layout.
 *
 * So: this module imports NOTHING, reads no environment, and runs no code at
 * load. `harness.ts` re-exports it for the Playwright side; `site-config.test.ts`
 * imports it directly.
 */

/** One migrated React screen and the single fact its smoke spec asserts. */
export interface ConsoleScreen {
	/** Human name, used as the test title. */
	readonly name: string;
	/** The increment that migrated it — for the reader of a failing run. */
	readonly increment: string;
	/** `adminPages[].path` on the `otta-console` descriptor. */
	readonly path: string;
	/** The accessible name of the heading the screen renders once loaded.
	 *  Matched by ROLE, not by text: a screen's name also appears in the sidebar
	 *  link and, on some screens, in the table caption. */
	readonly heading: RegExp;
}

/**
 * THE REGISTRY IS THE COVERAGE GATE.
 *
 * `console-screens.spec.ts` generates one smoke spec per entry, so a screen
 * cannot be migrated to React and left uncovered: adding the entry IS adding
 * the spec. `site-config.test.ts` closes the other half — a console page that
 * does not appear in this list fails the unit suite.
 *
 * IT WAS EMPTY AFTER INC-19, and that was the correct reading of it rather than
 * an oversight. INC-19 shipped a console SHELL — a landing page that never
 * existed on Block Kit — so nothing had been migrated, and putting the shell in
 * here would have made "migrated" mean "React", the registry stop being a
 * statement about ADR-0014 Decision 6's scope, and the count stop answering
 * "how many Block Kit screens have been replaced". That shell has since been
 * removed (ADR-0015): it managed no data, so the list below is now the console's
 * WHOLE page inventory as well as its migration count, and the two questions
 * happen to have the same answer rather than having been merged.
 *
 * INC-20 ADDS ORDERS, AND IT IS THE FIRST REAL ENTRY. The Block Kit original
 * stayed in the tree, in the sidebar and under its own sandbox suite for the
 * whole parallel period — ADR-0014 Decision 1 was reaffirmed, not spent.
 * ADR-0015 is the user's ruling that ended it: INC-R2 moved the write path off
 * that screen and retired it, so `/orders` is a console page only and the Block
 * Kit inventory is down to six.
 *
 * INC-21 ADDS PRICING & INVENTORY, and INC-R3 retired its original too — so both
 * entries below have replaced the screen they were migrated from, and the Block
 * Kit inventory is down to FIVE. Tax, Shipping and Settings stay Block Kit
 * permanently (ADR-0014 Decision 6) and must never appear here; Reports and
 * Coupons are a ruling the user has not made (D3), so adding either is out of
 * scope until they do.
 */
export const MIGRATED_SCREENS: readonly ConsoleScreen[] = [
	{
		name: "Orders",
		increment: "INC-20",
		// It shared this path with the Block Kit screen for the parallel period —
		// they never collided, because a page's URL carries its plugin id — and
		// ADR-0015 retired that screen, so `/orders` is now this screen's alone.
		path: "/orders",
		// The H1 the screen renders. INC-R2 dropped the `(new)` sidebar suffix with
		// the screen it disambiguated from, so for THIS entry the nav label, the H1
		// and the table caption all read the same string. Measured in a browser: a
		// text match resolved to all three and `.first()` took the SIDEBAR, so the
		// smoke spec had stopped distinguishing "the screen rendered" from "the
		// sidebar rendered". Its consumers now match the heading ROLE, which is
		// unique — so this stays the H1's own text; disambiguating it here, by
		// reviving a suffix, would be fixing the wrong file.
		heading: /^Orders$/,
	},
	{
		name: "Pricing & inventory",
		increment: "INC-21",
		// It shared this path with the Block Kit screen for the parallel period —
		// they never collided, because a page's URL carries its plugin id — and
		// INC-R3 retired that screen, so `/products` is now this screen's alone.
		path: "/products",
		// The H1. The `&` is rendered from an HTML entity, so the regex matches the
		// TEXT the browser produces rather than the source. INC-R3 dropped the
		// `(new)` sidebar suffix with the screen it disambiguated from, so — exactly
		// as on `/orders` — the nav label and this heading now read the same string
		// and the anchors no longer separate them. Its consumers match the heading
		// ROLE, which is unique; reviving a suffix to disambiguate a TEXT match
		// would be fixing the wrong file.
		heading: /^Pricing & inventory$/,
	},
];

/** Screens ADR-0014 Decision 6 forbids migrating — pinned so a future
 *  increment cannot quietly add one to the registry above. */
export const NEVER_MIGRATED_PATHS: readonly string[] = ["/tax", "/shipping", "/settings"];
