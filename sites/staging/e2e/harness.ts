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
 * `pnpm test` (vitest) never RUNS anything in this directory:
 * `sites/staging/vitest.config.ts` includes only `test/**\/*.test.ts`, and these
 * files are `*.spec.ts` under `e2e/`. The two runners do not overlap by
 * construction.
 *
 * That sentence was briefly untrue, which is worth recording because "by
 * construction" was doing real work in it. INC-19 had `site-config.test.ts`
 * import the migrated-screen registry from THIS file — never RUN by vitest, but
 * very much LOADED by it — which dragged in `@playwright/test` (undeclared in
 * `sites/staging`, resolving only by walking up to the root) and, worse, the
 * module-load env guards below. `COMMERCE_SERVICE_URL` is the staging site's
 * ordinary BUILD-time variable, so merely having it set to a real URL made the
 * whole unit suite throw on an e2e loopback check it was never subject to.
 *
 * The registry now lives in `./registry.js` — no imports, no environment, no
 * code at load — and this file re-exports it. Anything else the unit tier ever
 * needs from here belongs there too.
 */
import { fileURLToPath } from "node:url";
import { expect, test as base, type Page, type TestInfo } from "@playwright/test";

/**
 * DIRECTOR-SPEC §0.4. Playwright's `fullPage: true` truncates these pages, so
 * every shot is taken at an explicit viewport instead — and comparisons against
 * `audit/shots/` are only valid at the same size. Pinned by `harness.spec.ts`
 * against the resolved project config, not just declared here.
 */
export const E2E_VIEWPORT = { width: 1440, height: 2200 } as const;

/**
 * Loopback hostnames, and the guard that keeps every e2e endpoint on one.
 *
 * `COMMERCE_SERVICE_URL` and `PG_CONNECTION_STRING` are ordinary deployment
 * variables: a shell that has been used to deploy or to tunnel exports them
 * pointing at real infrastructure, and this harness reads both. Nothing about
 * "it is only a test run" stops an inherited export from aiming the stack boot,
 * or a dev-bypass POST, at production. So the values are guarded rather than
 * trusted, at module load, where the failure is loud and precedes any request.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** How the guard explains itself. One string, so the parse failure and the
 *  remote-host failure read the same and point at the same section. */
const LOOPBACK_RULE = "The e2e harness never talks to a remote host: see DIRECTOR-SPEC §0.2/§0.3.";

export function assertLoopbackUrl(raw: string, label: string): string {
	let host: string;
	try {
		host = new URL(raw).hostname;
	} catch {
		// A `PG_CONNECTION_STRING` in libpq's KEYWORD form — `host=… port=… `
		// `dbname=…`, which psql and most tooling accept — is not a URL, so
		// `new URL()` throws a bare `TypeError: Invalid URL` naming neither the
		// variable nor the value. That is the wrong failure for a guard whose
		// whole job is to be legible at 2am: it reads like a harness bug rather
		// than like "your shell has a connection string this run cannot check".
		// Unparseable is also NOT a pass — an unverifiable endpoint gets the same
		// answer as a remote one.
		throw new Error(
			`${label} must be a URL this guard can parse, got ${raw}. Connection strings in ` +
				`libpq keyword form (\`host=… port=…\`) are not URLs — use the URI form, ` +
				`e.g. postgres://postgres:postgres@127.0.0.1:55432/otta. ${LOOPBACK_RULE}`,
		);
	}
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error(
			`${label} must point at loopback for an e2e run, got ${host} (from ${raw}). ` + LOOPBACK_RULE,
		);
	}
	return raw;
}

/** The staging site, per §0.2 (`astro dev --port 4500`). */
export const E2E_BASE_URL = assertLoopbackUrl(
	process.env["OTTA_E2E_BASE_URL"] ?? "http://127.0.0.1:4500",
	"OTTA_E2E_BASE_URL",
);

/** The commerce service the site is built against, per §0.2. */
export const E2E_SERVICE_URL = assertLoopbackUrl(
	process.env["COMMERCE_SERVICE_URL"] ?? "http://127.0.0.1:3500",
	"COMMERCE_SERVICE_URL",
);

/**
 * The LOCAL TEST database — container `urumi-pg-test`, port **55432**.
 *
 * Port 5432 on localhost is an SSH tunnel to PRODUCTION Azure Postgres (§0.3).
 * No config, script or command in this harness may name it; `harness.spec.ts`
 * greps this file and `playwright.config.ts` for it and fails on a hit.
 */
export const E2E_PG_CONNECTION_STRING = assertLoopbackUrl(
	process.env["PG_CONNECTION_STRING"] ?? "postgres://postgres:postgres@127.0.0.1:55432/otta",
	"PG_CONNECTION_STRING",
);

/** Opt in to having Playwright boot the §0.2 stack itself (off by default: a
 *  bare `pnpm test:e2e` must not try to start a database-backed service). */
export const E2E_STARTS_STACK = process.env["OTTA_E2E_START_STACK"] === "1";

/** Turn "no site running" from a skip into a failure. */
export const E2E_REQUIRES_SITE = process.env["OTTA_E2E_REQUIRE_SITE"] === "1";

/**
 * Dev-only sign-in. §0.2 reaches for `/_emdash/api/setup/dev-bypass`, which
 * ALSO runs `applySeed(..., includeContent: true)` — re-seeding the site on
 * every spec is a side effect a read should not have (the repo's own seed
 * script says exactly this, `sites/staging/scripts/seed-demo-commerce.ts`, which refuses to re-seed a site that is fine). The
 * harness therefore defaults to the sign-in-only route and keeps §0.2's
 * seeding variant one env var away, for a run that wants a freshly seeded site.
 *
 * INC-19 KEPT THE DEFAULT, and could say why rather than guess: the console's
 * one spec asserted that `otta`'s admin route ANSWERS, not what it answers with.
 * That route returns 200 with a banner or an empty table when commerce data is
 * absent (G5 — a non-2xx would unmount the block tree), so a signed-in session
 * was the entire prerequisite and re-seeding would have bought the run nothing
 * for the cost of mutating the site on every spec.
 *
 * INC-20 IS THE CASE THAT COMMENT ANTICIPATED, and the default STILL DOES NOT
 * MOVE. The migrated Orders screen does assert on ROWS, but seeding on every
 * sign-in would re-seed once per spec — the side effect the repo's own seed
 * script warns about (`sites/staging/scripts/seed-demo-commerce.ts`, which refuses to re-seed a site that is fine) — to serve a
 * handful of them. The row-dependent specs call {@link skipWithoutOrders}
 * instead: they state what they need, skip loudly when a run has no orders, and
 * FAIL under `OTTA_E2E_REQUIRE_SITE=1`, so a gate run cannot report green
 * because the fixtures were missing. A run that wants rows sets
 * `OTTA_E2E_SEED_ON_AUTH=1`, or seeds the stack once before the run — which is
 * what INC-20's own gate run did.
 */
export const DEV_BYPASS_SIGNIN_PATH = "/_emdash/api/auth/dev-bypass";
/** §0.2 verbatim — signs in AND applies the full seed. */
export const DEV_BYPASS_SETUP_PATH = "/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin";
export const DEV_BYPASS_PATH =
	process.env["OTTA_E2E_SEED_ON_AUTH"] === "1" ? DEV_BYPASS_SETUP_PATH : DEV_BYPASS_SIGNIN_PATH;

/** ADR-0014's second descriptor id. The React screens live under it and under
 *  nothing else — a React page added under id `otta` would hide ALL SEVEN of
 *  that plugin's Block Kit pages from the sidebar (the `adminMode` granularity
 *  trap, ADR-0014 Decision 7). Seven, not "the other six": once the plugin's
 *  adminMode flips to "react", the sidebar keeps only pages that HAVE a React
 *  component, and the seven Block Kit ones do not. (ADR-0014's prose says six;
 *  correcting the ADR belongs to the docs increment, not to this file.) */
export const CONSOLE_PLUGIN_ID = "otta-console";

/** The Block Kit plugin that keeps its seven screens. */
export const OTTA_PLUGIN_ID = "otta";

/**
 * EmDash mounts a plugin's admin pages under the admin root.
 *
 * VERIFIED BY INC-19, which was the first increment with a real console page.
 * Both halves held as INC-18 guessed them, and both are now read off
 * `@emdash-cms/admin@0.31.1` rather than inferred: the sidebar builder emits
 * `to: \`/plugins/${pluginId}${page.path}\`` and the router registers
 * `/plugins/$pluginId/$`, deriving the page path as `"/" + (_splat || "")`.
 * `ADMIN_BASE_PATH` is the Astro route the SPA is served from
 * (`/_emdash/admin/[...path]`).
 *
 * They stay defined once, here, so `consoleScreenUrl`, the specs, and the
 * literal pin in `harness.spec.ts` cannot drift apart if a later EmDash changes
 * the shape.
 */
export const ADMIN_BASE_PATH = "/_emdash/admin";

/** URL of a console screen, given its descriptor `adminPages[].path`. */
export function consoleScreenUrl(path: string): string {
	return `${ADMIN_BASE_PATH}/plugins/${CONSOLE_PLUGIN_ID}${path}`;
}

/**
 * How long the admin SPA may take to hand a console page to React.
 *
 * MEASURED, not padded. Until the shell boots, every admin URL renders the
 * literal string "Loading EmDash…" and no plugin page exists in the DOM at all,
 * so a first assertion racing that boot fails with "element(s) not found" —
 * which reads like a broken selector and is not one. Against an `astro dev`
 * server on this box the boot lands between roughly 5 and 25 seconds per fresh
 * browser context, so the default `expect` timeout of 10s fails
 * NON-DETERMINISTICALLY: INC-19's specs passed and failed on the same code in
 * consecutive runs.
 *
 * The cause is the thing ADR-0014 names as the real marginal cost of this
 * amendment: `PluginRegistry.js` is 7.94 MB raw / 1.90 MB gzipped BEFORE any
 * migration, and in dev Vite compiles and serves that graph on demand.
 *
 * This is a wait sized to a known-slow bundle, NOT a weakened assertion — the
 * assertion is unchanged and still fails if the page never renders. Use it for
 * the FIRST assertion after a full page load; everything after it is
 * client-side routing and needs no extra headroom.
 */
export const ADMIN_SHELL_TIMEOUT_MS = 60_000;

/** A sidebar link belonging to the Block Kit `otta` plugin. The trailing slash
 *  is load-bearing: without it this also matches `otta-console`, and the
 *  assertion it backs — that a React page has NOT hidden the seven Block Kit
 *  screens (ADR-0014 Decision 7) — would pass vacuously. */
export const BLOCK_KIT_SIDEBAR_LINK = `a[href*="${ADMIN_BASE_PATH}/plugins/${OTTA_PLUGIN_ID}/"]`;

/**
 * The migrated-screen registry lives in its own module and is RE-EXPORTED here.
 *
 * Playwright code reaches it through the harness, as it always did; the vitest
 * side imports `./registry.js` directly and therefore never loads this file,
 * its `@playwright/test` import, or the env guards below. See `registry.ts` for
 * why that separation is load-bearing rather than tidy.
 */
export type { ConsoleScreen } from "./registry.js";
export { CONSOLE_SHELL, MIGRATED_SCREENS, NEVER_MIGRATED_PATHS } from "./registry.js";

/** This worktree's root, absolute — the identity a served build is checked
 *  against. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");

/**
 * Does the server at `E2E_BASE_URL` belong to THIS worktree?
 *
 * It matters because ports are shared and worktrees are not. A stray
 * `astro dev --port 4500` from a sibling worktree was live on this box while
 * INC-18 was written, and `reuseExistingServer` would have adopted it silently:
 * the gate would then have been testing someone else's tree and reporting green
 * for ours. That is a wrong answer, not a flake.
 *
 * The probe is Vite's `/@fs/` route, which serves only paths inside the dev
 * server's own `fs.allow` roots. Asking a foreign server for OUR absolute path
 * gets 403; asking ours gets 200. Measured, both directions, against a real
 * foreign server.
 *
 * ONLY 2xx COUNTS AS OURS — including for a server that has no `/@fs/` route at
 * all, such as a built/preview server, which answers 404. INC-18's comment
 * claimed the softer rule ("treated as 'not ours' only when it is a definite
 * deny"); the code has always been `return res.ok`, and the code is right. The
 * failure this guard exists to prevent is grading the wrong tree and reporting
 * green, so an answer the probe cannot positively attribute to this worktree
 * must not be read as attribution. The cost of the strict reading is a skip
 * (or, under `OTTA_E2E_REQUIRE_SITE=1`, a loud failure) when someone points the
 * harness at a preview server — visible, and fixed by running `astro dev`.
 */
async function serverIsThisWorktree(): Promise<boolean> {
	try {
		const res = await fetch(`${E2E_BASE_URL}/@fs${REPO_ROOT}/package.json`, {
			redirect: "manual",
			signal: AbortSignal.timeout(3_000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

let sitePromise: Promise<boolean> | undefined;

/**
 * Is a staging site from THIS worktree answering at `E2E_BASE_URL`? Probed once
 * per worker. A server that answers but belongs to another tree counts as
 * absent, so specs skip (or, under `OTTA_E2E_REQUIRE_SITE=1`, fail loudly)
 * rather than silently grade the wrong code.
 */
export function siteIsUp(): Promise<boolean> {
	sitePromise ??= (async () => {
		try {
			const res = await fetch(E2E_BASE_URL, {
				redirect: "manual",
				signal: AbortSignal.timeout(3_000),
			});
			if (res.status >= 500) return false;
		} catch {
			return false;
		}
		return serverIsThisWorktree();
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
		`no staging site from THIS worktree (${REPO_ROOT}) at ${E2E_BASE_URL} — boot the ` +
		`stack (DIRECTOR-SPEC §0.2) or set OTTA_E2E_START_STACK=1 to have Playwright boot ` +
		`it. A server from another worktree on the same port does not count.`;
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

/**
 * Skip (or, under `OTTA_E2E_REQUIRE_SITE=1`, fail) when the stack has no orders.
 *
 * WHY THIS EXISTS RATHER THAN A SEEDING DEFAULT. A migrated screen's specs
 * divide cleanly: the ones that assert on the SCREEN (it renders, its filters
 * round-trip, its empty state is honest) hold against any data, and the ones
 * that assert on a ROW (row click opens the detail, the copy button copies a
 * full id, a refund confirm names the short id) need at least one order to
 * exist. Seeding on every sign-in to serve the second group would mutate the
 * site on every spec in the first.
 *
 * IT IS LOUD IN BOTH DIRECTIONS. A local run skips with a message that says
 * exactly what to do; a gate run (`OTTA_E2E_REQUIRE_SITE=1`) throws, because
 * "there were no orders so we asserted nothing" is the single most plausible way
 * for this suite to report green while covering none of the acceptance it was
 * written for.
 */
export async function skipWithoutOrders(testInfo: TestInfo, rowCount: number): Promise<void> {
	if (rowCount > 0) return;
	const how =
		"the stack has no orders, so this spec cannot exercise a row. Seed it " +
		"(DIRECTOR-SPEC §0.2) or set OTTA_E2E_SEED_ON_AUTH=1 for this run.";
	if (E2E_REQUIRES_SITE) throw new Error(`OTTA_E2E_REQUIRE_SITE=1 and ${how}`);
	testInfo.skip(true, how);
}

/**
 * Skip (or, under `OTTA_E2E_REQUIRE_SITE=1`, fail) when the stack has no
 * products.
 *
 * ITS OWN MESSAGE, NOT {@link skipWithoutOrders}'S, for the reason that helper's
 * neighbour already records: "no orders" and "no products" have different causes
 * and different fixes. They are also NOT the same condition — a stack seeded
 * with a catalog but no checkouts has products and no orders, which is the
 * ordinary state of a freshly-seeded local stack.
 */
export async function skipWithoutProducts(testInfo: TestInfo, rowCount: number): Promise<void> {
	if (rowCount > 0) return;
	const how =
		"the stack has no products, so this spec cannot exercise a row. Seed it " +
		"(DIRECTOR-SPEC §0.2) or set OTTA_E2E_SEED_ON_AUTH=1 for this run.";
	if (E2E_REQUIRES_SITE) throw new Error(`OTTA_E2E_REQUIRE_SITE=1 and ${how}`);
	testInfo.skip(true, how);
}

/**
 * Skip (or, under `OTTA_E2E_REQUIRE_SITE=1`, fail) when no product on the page
 * has an inventory record to move stock against.
 *
 * A DIFFERENT CAUSE AND A DIFFERENT FIX AGAIN. A product with no SKU, or with a
 * SKU that predates the seed-on-first-sku behaviour, renders a one-line
 * explanation in place of both stock forms — by design (D-7). A spec that needs
 * the forms must say THAT rather than "no products", which would send the reader
 * to the seed where nothing is wrong.
 */
export async function skipWithoutStockableProduct(testInfo: TestInfo): Promise<void> {
	const how =
		"no product on the first page has an inventory record, so neither stock " +
		"form renders. Seed the stack (DIRECTOR-SPEC §0.2), or price a product and " +
		"give it a SKU so the service mints its stock row.";
	if (E2E_REQUIRES_SITE) throw new Error(`OTTA_E2E_REQUIRE_SITE=1 and ${how}`);
	testInfo.skip(true, how);
}

/**
 * Skip (or, under `OTTA_E2E_REQUIRE_SITE=1`, fail) when no order on the stack
 * has anything left to refund.
 *
 * ITS OWN MESSAGE, NOT {@link skipWithoutOrders}'S, and the distinction is the
 * whole value of it. "No orders" and "orders, but none refundable" have
 * different causes and different fixes, and the first INC-20 gate run reported
 * the second as the first — which sent the reader to the seed, where nothing
 * was wrong. A local stack runs Stripe in offline mode, so it captures nothing
 * and every order's `remainingCents` is 0; the fix is a capture pass, not more
 * seeding.
 */
export async function skipWithoutRefundableOrder(testInfo: TestInfo): Promise<void> {
	const how =
		"the stack has orders but none with money left to refund. A local service " +
		"runs Stripe in offline mode (STRIPE_WEBHOOK_SECRET set, STRIPE_SECRET_KEY " +
		"unset), which captures nothing — so no refund control renders on EITHER " +
		"Orders screen. Run `sites/staging/scripts/capture-e2e-payments.ts` against " +
		"the stack after seeding it.";
	if (E2E_REQUIRES_SITE) throw new Error(`OTTA_E2E_REQUIRE_SITE=1 and ${how}`);
	testInfo.skip(true, how);
}

/**
 * Close EmDash's first-login welcome dialog, if this run drew one.
 *
 * The dev-bypass account is created on first use, and EmDash greets a
 * newly-created account with a modal ("Welcome to EmDash, Dev!") over a dimmed
 * backdrop. It does not block assertions — the page behind it stays in the DOM
 * and visible — but it does cover roughly half of a 1440x2200 screenshot, which
 * makes the shot poor evidence for the thing it is taken to show.
 *
 * Conditional and non-waiting on purpose: the dialog appears once per account,
 * so a run against an already-greeted site must not sit here burning a timeout.
 *
 * The wait is on the GREETING, not on the button. Clicking `Get Started` starts
 * a request and relabels the button to "Loading…", so waiting for the button to
 * disappear by name returns instantly — and the shot still catches the modal
 * mid-dismissal, which is how the first version of this helper produced exactly
 * the screenshot it was written to prevent.
 */
const WELCOME_GREETING = /Welcome to EmDash/i;

export async function dismissWelcomeDialog(page: Page): Promise<void> {
	const greeting = page.getByText(WELCOME_GREETING);
	if ((await greeting.count()) === 0) return;
	await page
		.getByRole("button", { name: /get started/i })
		.first()
		.click();
	await expect(greeting.first()).toBeHidden();
}

export { expect };
