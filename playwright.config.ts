/**
 * Playwright — the contract gate for the React admin console, and for nothing
 * else.
 *
 * ADR-0014 permits a second EmDash descriptor (`otta-console`,
 * `format: "native"`) to render React admin pages. ADR-0006 Decision 1 is
 * REAFFIRMED by it: the 18 `packages/plugin/test/*.sandbox.test.ts` suites stay
 * the contract gate for `@otta-sh/plugin`. Those suites are browser-blind, so
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
 * `OTTA_E2E_START_STACK=1` has Playwright boot DIRECTOR-SPEC §0.2's stack.
 */
import { defineConfig } from "@playwright/test";
import {
	E2E_BASE_URL,
	E2E_PG_CONNECTION_STRING,
	E2E_SERVICE_URL,
	E2E_STARTS_STACK,
	E2E_VIEWPORT,
} from "./sites/staging/e2e/harness.js";

/** DIRECTOR-SPEC §0.2, step 1 + step 2 — opt-in, because booting a
 *  database-backed service is not something a bare `pnpm test:e2e` should do.
 *  The database is the LOCAL test Postgres on **55432**. Port 5432 is an SSH
 *  tunnel to PRODUCTION (§0.3) and must appear nowhere in this repo's e2e
 *  surface; `harness.spec.ts` enforces that by grepping these two files. */
const stack = [
	{
		command: "pnpm dlx tsx@4 packages/service/src/index.ts",
		url: `${E2E_SERVICE_URL}/health`,
		reuseExistingServer: true,
		timeout: 120_000,
		env: {
			PORT: new URL(E2E_SERVICE_URL).port,
			PG_CONNECTION_STRING: E2E_PG_CONNECTION_STRING,
			INTERNAL_API_TOKEN: process.env["INTERNAL_API_TOKEN"] ?? "local-e2e-token",
		},
	},
	{
		// COMMERCE_SERVICE_URL is BUILD-TIME (sites/staging/README.md): it is
		// baked into the plugin bundle and into the descriptor's allowedHosts,
		// so it has to be set on the dev process, not flipped at runtime.
		command: `pnpm --filter @otta-sh/site-staging dev --port ${new URL(E2E_BASE_URL).port}`,
		url: E2E_BASE_URL,
		reuseExistingServer: true,
		timeout: 180_000,
		env: { COMMERCE_SERVICE_URL: E2E_SERVICE_URL },
	},
];

export default defineConfig({
	testDir: "sites/staging/e2e",
	testMatch: /.*\.spec\.ts$/,
	// Artifacts land under node_modules/ so a run never dirties the tree; the
	// repo has no ignore entry for Playwright output and this increment does
	// not add one.
	outputDir: "node_modules/.playwright-artifacts",
	preserveOutput: "failures-only",
	reporter: [["list"]],
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
		// §0.4: `fullPage: true` truncates these pages, so shots are taken at an
		// explicit viewport instead — and every audit shot in `audit/shots/` uses
		// this size, so a comparison at any other size is invalid.
		viewport: { ...E2E_VIEWPORT },
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
		video: "off",
	},
	...(E2E_STARTS_STACK ? { webServer: stack } : {}),
});
