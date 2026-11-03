/**
 * Playwright — the setup-claim link on a FRESH store (ADR-0042), and nothing
 * else. `pnpm test:e2e:claim`.
 *
 * WHY A SECOND CONFIG. The link flow only exists while a store is unclaimed,
 * and the main suite's stack is claimed by its own seed before the first spec
 * runs. So this config boots its own dev server on its own port over a state
 * directory it wipes first (`OTTA_E2E_PERSIST_DIR`, read by astro.config.ts in
 * dev only), runs no global setup and seeds nothing.
 *
 * ONE `astro dev` PER PROJECT. Astro locks the project, so this cannot run
 * while another dev server of this worktree is up (the main suite's included):
 * run it after `pnpm test:e2e`, as CI does. It always boots its own server and
 * never adopts one (`reuseExistingServer: false`).
 */
import { defineConfig } from "@playwright/test";
import { E2E_SETUP_TOKEN, E2E_VIEWPORT } from "./sites/staging/e2e/harness.js";
import { CLAIM_PORT, CLAIM_SITE, CLAIM_STATE_DIR } from "./sites/staging/e2e/claim/claim-stack.js";
import { SETUP_TOKEN_SECRET } from "./sites/staging/src/lib/setup-claim-contract.js";

// The spec and the server hold the same token (e2e/harness.ts).
process.env[SETUP_TOKEN_SECRET] = E2E_SETUP_TOKEN;

export default defineConfig({
	testDir: "sites/staging/e2e/claim",
	testMatch: /.*\.spec\.ts$/,
	outputDir: "node_modules/.playwright-artifacts-claim",
	preserveOutput: "failures-only",
	reporter: [["list"]],
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: process.env["CI"] !== undefined,
	// A cold server compiles the admin shell on the first load.
	timeout: 180_000,
	expect: { timeout: 30_000 },
	use: {
		baseURL: CLAIM_SITE,
		browserName: "chromium",
		headless: true,
		viewport: { ...E2E_VIEWPORT },
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
		video: "off",
	},
	webServer: {
		command:
			`rm -rf "${CLAIM_STATE_DIR}" && ` +
			`pnpm --filter @urumi.ai/otta-site-staging dev --port ${String(CLAIM_PORT)} --host 127.0.0.1`,
		url: `http://127.0.0.1:${String(CLAIM_PORT)}/`,
		stdout: "pipe",
		stderr: "pipe",
		reuseExistingServer: false,
		timeout: 180_000,
		env: {
			// Foreground, so Playwright owns the server (see playwright.config.ts).
			ASTRO_DEV_BACKGROUND: "1",
			OTTA_E2E_PERSIST_DIR: CLAIM_STATE_DIR,
			CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
			[SETUP_TOKEN_SECRET]: E2E_SETUP_TOKEN,
		},
	},
});
