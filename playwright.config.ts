/**
 * Playwright — the contract gate for the React admin console, and for nothing
 * else.
 *
 * ADR-0014 permits a second EmDash descriptor (`otta-console`,
 * `format: "native"`) to render React admin pages. ADR-0006 Decision 1 is
 * REAFFIRMED by it: the 24 `packages/plugin/test/*.sandbox.test.ts` suites stay
 * the contract gate for `@urumi.ai/otta-plugin`. Those suites are browser-blind, so
 * they cannot cover React — hence this config. It is **additive**. Nothing here
 * weakens, replaces or conditions the sandbox gate, and
 * `sites/staging/e2e/harness.spec.ts` proves that on every run.
 *
 * Headless, one worker, no `.only` in CI, no HTML reporter, no MCP browser.
 * Browsers come from `npx playwright install chromium`.
 *
 * Run it with `pnpm test:e2e`. With no stack running the per-screen specs skip
 * themselves and the server-free gates still run, so the command is green on a
 * bare checkout; `OTTA_E2E_REQUIRE_SITE=1` turns those skips into failures and
 * `OTTA_E2E_START_STACK=1` has Playwright boot the local stack itself
 * (`sites/staging/README.md`, "Local development").
 */
import { existsSync, readFileSync } from "node:fs";
import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import {
	E2E_BASE_URL,
	E2E_SETUP_TOKEN,
	E2E_STARTS_STACK,
	E2E_VIEWPORT,
} from "./sites/staging/e2e/harness.js";
import { SETUP_TOKEN_SECRET } from "./sites/staging/src/lib/setup-claim-contract.js";
import { DEV_VARS_PATH } from "./sites/staging/scripts/setup-claim-cookie.js";
import { parseDotEnv } from "./sites/staging/src/lib/dot-env.js";
import {
	markServerStartedCommand,
	serverStartedMarkerPath,
} from "./sites/staging/e2e/server-started-marker.js";

// ADR-0042: an unclaimed store admits only the setup-token holder, with no
// development exception. Every process of this run (global setup, workers, the
// scripts they call) and the dev server below read the SAME token from here.
process.env[SETUP_TOKEN_SECRET] = E2E_SETUP_TOKEN;

// A `sites/staging/.dev.vars` (README step 1 creates one for the encryption key)
// replaces the env injected into the dev Worker. Without OTTA_SETUP_TOKEN in it, a
// stack this run boots mints its own token, and every `/_emdash` call (global
// setup's dev-bypass included) answers 403. Say so up front. A warning, not a
// refusal: a store already claimed by hand never needs the token.
if (E2E_STARTS_STACK && existsSync(DEV_VARS_PATH)) {
	const devVars = parseDotEnv(readFileSync(DEV_VARS_PATH, "utf8"));
	if ((devVars[SETUP_TOKEN_SECRET] ?? "") === "") {
		console.warn(
			`playwright.config.ts: ${DEV_VARS_PATH} exists but does not set ${SETUP_TOKEN_SECRET}. ` +
				`Wrangler gives the dev Worker that file INSTEAD of the injected env, so an unclaimed ` +
				`store will refuse this run with 403s. Add ${SETUP_TOKEN_SECRET}=<32+ random characters> ` +
				`to it, or claim the store by hand first (README, "A fresh store is locked").`,
		);
	}
}

/** Playwright does not export `TestConfigWebServer`, so it is reached through
 *  the config type. The annotation dates from when `stack` held two entries and
 *  inferred a UNION whose `env` members carried `?: undefined` optionals, which
 *  the index signature `{ [k: string]: string }` rejects — a real TS2769 that
 *  went unnoticed because nothing type-checked this file. It is kept now that
 *  INC-D3b left one entry: it costs nothing and restores the same guard the
 *  moment a second process is ever added back. */
type WebServer = Extract<
	NonNullable<PlaywrightTestConfig["webServer"]>,
	readonly unknown[]
>[number];

/**
 * A THROWAWAY `EMDASH_ENCRYPTION_KEY` for the stack this config boots, and for
 * nothing else (ADR-0037). The seeded setup saves a Stripe webhook secret
 * through Settings, and EmDash refuses to store a declared secret without an
 * encryption key. It protects only the disposable local `.wrangler` state of an
 * e2e run, so it is fine in the repo; never use it for a real site. A key already
 * in the environment wins.
 */
const E2E_TEST_ENCRYPTION_KEY = "emdash_enc_v1_cugE5mpPbewXCXUpUxvpscThKOCTYMxr1Ro8lVSc_Ps";

/**
 * The local stack (`sites/staging/README.md`, "Local development") — opt-in,
 * because booting a dev server is not something a bare `pnpm test:e2e` should do.
 *
 * ONE ENTRY, not two. Until INC-D3b this array booted a standalone commerce
 * service (`packages/service/src/index.ts`) against the local test Postgres and
 * waited on its `/health`, then the site beside it. INC-D3a folded commerce
 * into the plugin and INC-D3b deleted the service package, so there is a single
 * process to start and no commerce address, port or `INTERNAL_API_TOKEN` to
 * hand it. The loopback-only port rule is unchanged and is still enforced where it
 * always was — `assertLoopbackUrl` re-checks every resolved endpoint at harness
 * module load, and `harness.spec.ts` greps this file and the harness for a bare
 * 5432 (the SSH tunnel to PRODUCTION) on every run.
 *
 * `reuseExistingServer` is OFF under CI and on locally. Adopting whatever holds
 * the port is convenient at a desk and wrong in an automated run: a sibling
 * worktree's `astro dev --port 4500` was live on this box while INC-18 was
 * written. `siteIsUp()` independently verifies the answering server belongs to
 * this worktree, so a local reuse cannot silently grade the wrong tree either.
 */
const stack: WebServer[] = [
	{
		// The site needs NO commerce address: INC-D3a folded the service into the
		// plugin, so this dev server runs commerce in-process against its own
		// store. It used to be handed `COMMERCE_SERVICE_URL` here, which the build
		// no longer reads at all.
		// `--host` IS EXPLICIT, AND IT IS THE HOST PLAYWRIGHT POLLS. Without it Vite
		// listens on `localhost`, which binds whichever address the resolver lists
		// first. On this repo's dev boxes that is 127.0.0.1, but GitHub's Ubuntu
		// runners also map `::1` to `localhost` in /etc/hosts, so the server can come
		// up on IPv6 only while Playwright waits on http://127.0.0.1:4500. That is
		// how the first CI run of the e2e job failed: "Timed out waiting 180000ms
		// from config.webServer", with the server alive the whole time. The
		// brackets of an IPv6 literal (`[::1]`) are not part of the address Vite
		// takes.
		// #531: the marker first — it tells the global setup THIS run started the
		// server (Playwright skips the command when it reuses one), so placeholder
		// Stripe values never land in a developer's own running store.
		command:
			`${markServerStartedCommand()} && ` +
			`pnpm --filter @urumi.ai/otta-site-staging dev --port ${new URL(E2E_BASE_URL).port} ` +
			`--host ${new URL(E2E_BASE_URL).hostname.replace(/^\[|\]$/g, "")}`,
		url: E2E_BASE_URL,
		// Playwright's default is to DROP the server's stdout, which left the failed
		// CI run with one line of log for a three-minute wait. Piped, astro's own
		// startup lines and any error reach the job log, prefixed [WebServer].
		stdout: "pipe",
		stderr: "pipe",
		reuseExistingServer: process.env["CI"] === undefined,
		timeout: 180_000,
		env: {
			OTTA_E2E_SERVER_STARTED_MARKER: serverStartedMarkerPath(),
			// `astro@7`'s dev command DAEMONIZES ITSELF when it detects an agentic
			// environment (via `am-i-vibing` — Claude Code, Cursor and friends): it
			// spawns a background server and the foreground process exits, which
			// Playwright correctly reports as "Process from config.webServer exited
			// early" before aborting the run. Measured on INC-19, which was the
			// first increment to use this block: `OTTA_E2E_START_STACK=1` had never
			// worked from an agent session, and the abort left a dev server holding
			// the port afterwards — the exact stray-server hazard `siteIsUp()`
			// exists to catch. (Astro's lock is per PROJECT, so the leftover also
			// blocks every later `astro dev` in the worktree, on any port.)
			//
			// The variable reads backwards and is worth stating plainly: it does
			// NOT request background mode. `astro dev` computes
			// `agentDetected = !process.env.ASTRO_DEV_BACKGROUND && isRunByAgent()`,
			// so SETTING it to anything non-empty turns the auto-detection off, and
			// with no `--background` flag the server then runs in the FOREGROUND,
			// where Playwright can own its lifecycle. That is what this config
			// wants in every environment, agent or not: a webServer Playwright
			// cannot stop is a leaked process, not a convenience.
			ASTRO_DEV_BACKGROUND: "1",
			// Arms the plugin's dev-only offline Stripe gateway (issue #378), so this
			// stack can create orders with no Stripe account and the order seed can
			// mark them paid with a signed test webhook. It only works under `astro
			// dev`, and `astro build` refuses to run with it set
			// (sites/staging/src/lib/e2e-stripe-offline.ts).
			OTTA_E2E_STRIPE_OFFLINE: "1",
			// No STRIPE_PUBLIC_KEY (issue #498): the publishable key is a Settings
			// value, which e2e/global-setup.ts saves on a stack this run starts.
			// ADR-0037: payment keys are stored encrypted, so the dev Worker needs a
			// key. `astro dev` runs the Worker in workerd, which does NOT inherit this
			// process's environment: wrangler copies it in only when
			// CLOUDFLARE_INCLUDE_PROCESS_ENV is "true" (and there is no `.dev.vars`).
			EMDASH_ENCRYPTION_KEY: process.env["EMDASH_ENCRYPTION_KEY"] ?? E2E_TEST_ENCRYPTION_KEY,
			CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
			// The setup token the suite presents (ADR-0042; e2e/harness.ts). Reaches
			// workerd through CLOUDFLARE_INCLUDE_PROCESS_ENV, like the key above.
			[SETUP_TOKEN_SECRET]: E2E_SETUP_TOKEN,
		},
	},
];

export default defineConfig({
	testDir: "sites/staging/e2e",
	// Warms the dev server (and, under OTTA_E2E_SEED=1, seeds it) before the
	// first spec, so a cold server's compile time is not charged to whichever
	// console spec happens to run first. A no-op with no site up (issue #378).
	globalSetup: "./sites/staging/e2e/global-setup.ts",
	testMatch: /.*\.spec\.ts$/,
	// The setup-claim link spec needs a FRESH, unclaimed store of its own:
	// playwright.claim.config.ts (`pnpm test:e2e:claim`), never this stack.
	testIgnore: ["**/e2e/claim/**"],
	// Artifacts land under node_modules/ so a run never dirties the tree; the
	// repo has no ignore entry for Playwright output and this increment does
	// not add one.
	outputDir: "node_modules/.playwright-artifacts",
	preserveOutput: "failures-only",
	// Under CI a JUnit report rides along for the failure upload (ci.yml's e2e
	// job). Still no HTML reporter: nothing here serves or opens one.
	reporter:
		process.env["CI"] !== undefined
			? [["list"], ["junit", { outputFile: "node_modules/.playwright-report/junit.xml" }]]
			: [["list"]],
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: process.env["CI"] !== undefined,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	use: {
		baseURL: E2E_BASE_URL,
		browserName: "chromium",
		headless: true,
		// `fullPage: true` truncates these pages, so shots are taken at an
		// explicit viewport instead — and every audit shot in `audit/shots/` uses
		// this size, so a comparison at any other size is invalid.
		viewport: { ...E2E_VIEWPORT },
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
		video: "off",
	},
	...(E2E_STARTS_STACK ? { webServer: stack } : {}),
});
