/**
 * The React admin console's end-to-end harness.
 *
 * WHY THIS EXISTS. ADR-0014 lets a second EmDash descriptor (`otta-console`,
 * `format: "native"`) render React admin pages. The 18
 * `packages/plugin/test/*.sandbox.test.ts` suites — ADR-0006 Decision 1's
 * contract gate — are browser-blind and cannot cover a React screen, so
 * Playwright is added as the gate **for React screens only**.
 *
 * IT IS ADDITIVE. It replaces nothing. ADR-0014 reaffirms Decision 1 verbatim:
 * "None is deleted, skipped, weakened or made conditional by this amendment or
 * by any migration increment under it." `harness.spec.ts` asserts that
 * mechanically, server-free, on every `pnpm test:e2e` run — so the increment
 * that adds this gate is also the increment that pins the gate it is *not*
 * allowed to replace.
 *
 * WHAT RUNS WITHOUT A SERVER. Everything in `harness.spec.ts`. The per-screen
 * smoke specs need the §0.2 stack and skip themselves when it is absent, so
 * `pnpm test:e2e` is green on a bare checkout. Set `OTTA_E2E_REQUIRE_SITE=1`
 * (CI, or a run you actually want to trust) to turn those skips into failures.
 *
 * `pnpm test` (vitest) never sees this directory: `sites/staging/vitest.config.ts`
 * includes only `test/**\/*.test.ts`, and these files are `*.spec.ts` under
 * `e2e/`. The two runners do not overlap by construction.
 */
import { expect, test as base, type Page, type TestInfo } from "@playwright/test";

/**
 * DIRECTOR-SPEC §0.4. Playwright's `fullPage: true` truncates these pages, so
 * every shot is taken at an explicit viewport instead — and comparisons against
 * `audit/shots/` are only valid at the same size. Pinned by `harness.spec.ts`
 * against the resolved project config, not just declared here.
 */
export const E2E_VIEWPORT = { width: 1440, height: 2200 } as const;

/** The staging site, per §0.2 (`astro dev --port 4500`). */
export const E2E_BASE_URL = process.env["OTTA_E2E_BASE_URL"] ?? "http://127.0.0.1:4500";

/** The commerce service the site is built against, per §0.2. */
export const E2E_SERVICE_URL = process.env["COMMERCE_SERVICE_URL"] ?? "http://127.0.0.1:3500";

/**
 * The LOCAL TEST database — container `urumi-pg-test`, port **55432**.
 *
 * Port 5432 on localhost is an SSH tunnel to PRODUCTION Azure Postgres (§0.3).
 * No config, script or command in this harness may name it; `harness.spec.ts`
 * greps this file and `playwright.config.ts` for it and fails on a hit.
 */
export const E2E_PG_CONNECTION_STRING =
	process.env["PG_CONNECTION_STRING"] ?? "postgres://postgres:postgres@127.0.0.1:55432/otta";

/** Opt in to having Playwright boot the §0.2 stack itself (off by default: a
 *  bare `pnpm test:e2e` must not try to start a database-backed service). */
export const E2E_STARTS_STACK = process.env["OTTA_E2E_START_STACK"] === "1";

/** Turn "no site running" from a skip into a failure. */
export const E2E_REQUIRES_SITE = process.env["OTTA_E2E_REQUIRE_SITE"] === "1";

/**
 * Dev-only sign-in. §0.2 reaches for `/_emdash/api/setup/dev-bypass`, which
 * ALSO runs `applySeed(..., includeContent: true)` — re-seeding the site on
 * every spec is a side effect a read should not have (the repo's own seed
 * script says exactly this, `scripts/seed-demo-commerce.ts:303-306`). The
 * harness therefore defaults to the sign-in-only route and keeps §0.2's
 * seeding variant one env var away, for a run that wants a freshly seeded site.
 */
export const DEV_BYPASS_SIGNIN_PATH = "/_emdash/api/auth/dev-bypass";
/** §0.2 verbatim — signs in AND applies the full seed. */
export const DEV_BYPASS_SETUP_PATH = "/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin";
export const DEV_BYPASS_PATH =
	process.env["OTTA_E2E_SEED_ON_AUTH"] === "1" ? DEV_BYPASS_SETUP_PATH : DEV_BYPASS_SIGNIN_PATH;

/** ADR-0014's second descriptor id. The React screens live under it and under
 *  nothing else — a React page added under id `otta` would hide that plugin's
 *  six other Block Kit pages from the sidebar (the `adminMode` granularity
 *  trap, ADR-0014 Decision 7). */
export const CONSOLE_PLUGIN_ID = "otta-console";

/** EmDash mounts a plugin's admin pages under the admin root. INC-19 is the
 *  first increment to actually load one; if EmDash's admin router disagrees
 *  with this prefix, INC-19 corrects it HERE and every screen follows. */
export const ADMIN_BASE_PATH = "/_emdash/admin";

/** URL of a console screen, given its descriptor `adminPages[].path`. */
export function consoleScreenUrl(path: string): string {
	return `${ADMIN_BASE_PATH}/plugins/${CONSOLE_PLUGIN_ID}${path}`;
}

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
 * the spec, and leaving the entry out means the screen has no gate at all —
 * which `harness.spec.ts` makes visible by pinning this list against the
 * migration scope ADR-0014 Decision 6 fixes.
 *
 * EMPTY BY DESIGN at INC-18: nothing is migrated yet. INC-20 adds Orders,
 * INC-21 adds Pricing & inventory. Tax, Shipping and Settings stay Block Kit
 * permanently (ADR-0014 Decision 6) and must never appear here.
 */
export const MIGRATED_SCREENS: readonly ConsoleScreen[] = [];

/** Screens ADR-0014 Decision 6 forbids migrating — pinned so a future
 *  increment cannot quietly add one to the registry above. */
export const NEVER_MIGRATED_PATHS: readonly string[] = ["/tax", "/shipping", "/settings"];

let sitePromise: Promise<boolean> | undefined;

/** Is a staging site answering at `E2E_BASE_URL`? Probed once per worker. */
export function siteIsUp(): Promise<boolean> {
	sitePromise ??= (async () => {
		try {
			const res = await fetch(E2E_BASE_URL, {
				redirect: "manual",
				signal: AbortSignal.timeout(3_000),
			});
			return res.status < 500;
		} catch {
			return false;
		}
	})();
	return sitePromise;
}

/**
 * Skip (or, under `OTTA_E2E_REQUIRE_SITE=1`, fail) when the stack is absent.
 *
 * `testInfo.skip()` rather than `test.skip()`: this has to run from inside the
 * `adminPage` FIXTURE, because a fixture is set up before the test body and a
 * fixture that cannot reach the site would fail the test before any body-level
 * guard could skip it. Specs that take the raw `page` call it themselves with
 * `test.info()`.
 */
export async function skipWithoutSite(testInfo: TestInfo): Promise<void> {
	if (await siteIsUp()) return;
	const how =
		`no staging site at ${E2E_BASE_URL} — boot the stack (DIRECTOR-SPEC §0.2) or set ` +
		`OTTA_E2E_START_STACK=1 to have Playwright boot it`;
	if (E2E_REQUIRES_SITE) throw new Error(`OTTA_E2E_REQUIRE_SITE=1 and ${how}`);
	testInfo.skip(true, how);
}

/**
 * `adminPage` — a page already signed in as the dev admin, on a stack that is
 * actually there.
 *
 * Authentication is the dev-bypass URL and nothing else: the console reaches
 * the commerce service only through `otta`'s existing authenticated admin
 * routes (ADR-0014 Decision 3), so a real session is the entire prerequisite.
 */
export const test = base.extend<{ adminPage: Page }>({
	adminPage: async ({ page }, use, testInfo) => {
		await skipWithoutSite(testInfo);
		const res = await page.goto(DEV_BYPASS_PATH);
		expect(res?.status() ?? 599, `dev bypass ${DEV_BYPASS_PATH} did not sign in`).toBeLessThan(400);
		await use(page);
	},
});

export { expect };
