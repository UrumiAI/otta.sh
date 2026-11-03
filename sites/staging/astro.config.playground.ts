/**
 * Disposable Otta playground — the storefront site, on EmDash's per-visitor
 * playground database, with Otta registered.
 *
 *   pnpm --filter @urumi.ai/otta-site-staging dev:playground
 *   open /playground
 *
 * The storefront config (`astro.config.ts`) is unchanged and stays on D1.
 * This one runs the same `otta()` integration in playground mode, which swaps
 * the EmDash registration for `buildPlaygroundEmdashOptions`, bakes
 * `__OTTA_PLAYGROUND__` true and registers no email provider.
 */
import cloudflare from "@astrojs/cloudflare";
import otta from "@urumi.ai/otta-store";
import { defineConfig } from "astro/config";

export default defineConfig({
	// "passthrough": the adapter's default is the paid Cloudflare Images
	// binding (`IMAGES`). The playground has no image resizing product.
	adapter: cloudflare({
		configPath: "wrangler.playground.jsonc",
		imageService: "passthrough",
	}),
	integrations: [
		otta({
			template: 1,
			playground: true,
			envDir: new URL(".", import.meta.url),
			wranglerConfig: "wrangler.playground.jsonc",
		}),
	],
});
