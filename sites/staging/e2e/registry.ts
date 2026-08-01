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
	/** Text the screen must render once loaded. */
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
 * INC-20 ADDS ORDERS, AND IT IS THE FIRST REAL ENTRY. The count now answers its
 * question honestly: one of the seven Block Kit screens has a React replacement.
 * The Block Kit original stays in the tree, stays in the sidebar and stays
 * covered by `orders-page.sandbox.test.ts` — ADR-0014 Decision 1 is reaffirmed,
 * not spent, and both screens render until the user rules on removing one.
 *
 * INC-21 ADDS PRICING & INVENTORY, and with it the count answers its question
 * for the last time under this ADR: two of the seven Block Kit screens have a
 * React replacement. Tax, Shipping and Settings stay Block Kit permanently
 * (ADR-0014 Decision 6) and must never appear here; Reports and Coupons are a
 * ruling the user has not made (D3), so adding either is out of scope until
 * they do.
 */
export const MIGRATED_SCREENS: readonly ConsoleScreen[] = [
	{
		name: "Orders",
		increment: "INC-20",
		// The SAME path the Block Kit screen declares. They do not collide: a
		// page's URL carries its plugin id (`/plugins/otta/orders` versus
		// `/plugins/otta-console/orders`), and keeping the paths identical is what
		// lets the two be compared by swapping one segment while both render.
		path: "/orders",
		// The H1, not the sidebar label. `Orders (new)` is what the nav entry
		// says — deliberately, so two entries reading `Orders` are told apart
		// without a click — but the heading an operator lands on is the screen's
		// own, and matching the sidebar here would let a spec pass on a page that
		// never rendered.
		heading: /^Orders$/,
	},
	{
		name: "Pricing & inventory",
		increment: "INC-21",
		// Same path as the Block Kit screen, same reason as `/orders` above.
		path: "/products",
		// The H1, not the sidebar label (`Pricing & inventory (new)`). The `&` is
		// rendered from an HTML entity, so the regex matches the TEXT the browser
		// produces rather than the source. Anchored at both ends so the sidebar
		// label — which contains the heading as a prefix — cannot satisfy it.
		heading: /^Pricing & inventory$/,
	},
];

/** Screens ADR-0014 Decision 6 forbids migrating — pinned so a future
 *  increment cannot quietly add one to the registry above. */
export const NEVER_MIGRATED_PATHS: readonly string[] = ["/tax", "/shipping", "/settings"];
