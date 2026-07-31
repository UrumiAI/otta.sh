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
 * appears in neither this list nor `CONSOLE_SHELL` fails the unit suite.
 *
 * STILL EMPTY AFTER INC-19, and that is the correct reading of it rather than
 * an oversight. INC-19 ships the console SHELL — a landing page that never
 * existed on Block Kit — so nothing has been migrated and every operator-facing
 * screen is still the Block Kit one, unchanged and still covered by its sandbox
 * suite. Putting the shell in here would make "migrated" mean "React", the
 * registry stop being a statement about ADR-0014 Decision 6's scope, and the
 * count stop answering "how many Block Kit screens have been replaced". The
 * shell has its own gate instead: `CONSOLE_SHELL` below, and
 * `console-shell.spec.ts`.
 *
 * INC-20 adds Orders, INC-21 adds Pricing & inventory. Tax, Shipping and
 * Settings stay Block Kit permanently (ADR-0014 Decision 6) and must never
 * appear here.
 */
export const MIGRATED_SCREENS: readonly ConsoleScreen[] = [];

/**
 * The console shell — the one React page that exists before any migration.
 *
 * Kept OUT of `MIGRATED_SCREENS` (see above) but described in the same shape,
 * so `console-shell.spec.ts` reads like the generated per-screen specs and so
 * the shell's path is written down exactly once on the test side.
 *
 * `path` must equal `CONSOLE_HOME_PAGE.path` in `@otta-sh/admin-react`. The two
 * are not imported from one another on purpose: this file is the test surface's
 * own statement of what it expects to find, and a spec that imported the value
 * it is checking would pass no matter what the console shipped.
 */
export const CONSOLE_SHELL: ConsoleScreen = {
	name: "Console shell",
	increment: "INC-19",
	path: "/console",
	heading: /Otta console/i,
};

/** Screens ADR-0014 Decision 6 forbids migrating — pinned so a future
 *  increment cannot quietly add one to the registry above. */
export const NEVER_MIGRATED_PATHS: readonly string[] = ["/tax", "/shipping", "/settings"];
