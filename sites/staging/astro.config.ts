/**
 * Otta staging storefront + admin — the reference site, built the way a
 * merchant's site is: `@urumi.ai/otta-store`'s `otta()` integration supplies
 * the whole store (EmDash, the trusted Otta plugin, the routes, middleware,
 * theme, fonts and build guards; ADR-0045). The one-click template repository
 * is this file without the repository-only switches below.
 *
 * What only this repository adds:
 *  - `wrangler.local.jsonc`, the gitignored real deploy config, preferred over
 *    the tracked `wrangler.jsonc` placeholder template when it exists;
 *  - the Playwright e2e stack's own config and its fresh-state directory;
 *  - the e2e Stripe-offline switch (`astro dev` only).
 */
import { existsSync } from "node:fs";
import cloudflare from "@astrojs/cloudflare";
import otta from "@urumi.ai/otta-store";
import { defineConfig } from "astro/config";
import { devStripeOfflineIntegration } from "./src/lib/e2e-stripe-offline.js";
import {
	E2E_WRITE_LIMIT_VAR,
	e2eWranglerConfig,
	e2eWranglerIntegration,
} from "./src/lib/e2e-wrangler.js";

/**
 * Real deploy identifiers live in the gitignored `wrangler.local.jsonc`
 * (the tracked `wrangler.jsonc` is a placeholder TEMPLATE). The adapter
 * reads the wrangler config at BUILD time and emits the merged
 * `dist/server/wrangler.json` that plain `wrangler deploy` then follows
 * via `.wrangler/deploy/config.json` — so the local file must be selected
 * HERE, not with `wrangler deploy --config` (which bypasses the redirect
 * and tries to rebundle the raw worker source).
 */
const localWranglerConfig =
	/* The Playwright e2e stack's own config (ADR-0044: it adds RATE_LIMIT_WRITES,
	   so cash on delivery can be offered) — `astro dev` only; the integration
	   below refuses a build with it (src/lib/e2e-wrangler.ts). */
	e2eWranglerConfig(process.env[E2E_WRITE_LIMIT_VAR]) ??
	(existsSync(new URL("wrangler.local.jsonc", import.meta.url))
		? "wrangler.local.jsonc"
		: undefined);

/**
 * The config this build actually uses — the gitignored local config when there
 * is one, which no test sees; with no local file, the tracked template. The
 * adapter reads it (`configPath`) and `otta()` runs its guards on the SAME file
 * (`wranglerConfig`): the private downloads bucket must never be the public
 * media bucket (issue #376), and a configured sender needs the `EMAIL` binding
 * (ADR-0043).
 */
const selectedWranglerConfig = localWranglerConfig ?? "wrangler.jsonc";

export default defineConfig({
	// NOT `cloudflare({ imageService: "cloudflare" })` — that's the paid
	// image resizing product. The adapter's default image service binds IMAGES.
	adapter: cloudflare({
		...(localWranglerConfig !== undefined ? { configPath: localWranglerConfig } : {}),
		// DEV ONLY (`astro dev`; a build has no local state). The claim e2e config
		// (playwright.claim.config.ts, ADR-0042) boots its own stack on a FRESH,
		// unseeded state directory so the setup-claim link can be tested on a
		// store that is still unclaimed, without touching `.wrangler`.
		...(process.env["OTTA_E2E_PERSIST_DIR"] !== undefined &&
		process.env["OTTA_E2E_PERSIST_DIR"] !== ""
			? { persistState: { path: process.env["OTTA_E2E_PERSIST_DIR"] } }
			: {}),
	}),
	// `devStripeOfflineIntegration` bakes `__OTTA_DEV_STRIPE_OFFLINE__` — `true`
	// only under `astro dev` with OTTA_E2E_STRIPE_OFFLINE=1, for the e2e suite's
	// order seed (issue #378). An integration because only a hook can see the
	// command; see src/lib/e2e-stripe-offline.ts.
	integrations: [
		otta({
			template: 1,
			// OTTA_EXTRA_ALLOWED_HOSTS / OTTA_EMAIL_FROM fall back to THIS site's
			// `.env` (Astro does not load it into process.env for the config).
			envDir: new URL(".", import.meta.url),
			wranglerConfig: selectedWranglerConfig,
		}),
		devStripeOfflineIntegration(),
		e2eWranglerIntegration(),
	],
});
