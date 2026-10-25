/**
 * Disposable Otta playground — the storefront site, on EmDash's per-visitor
 * playground database, with Otta registered.
 *
 *   pnpm --filter @urumi.ai/otta-site-staging dev:playground
 *   open /playground
 *
 * The storefront config (`astro.config.ts`) is unchanged and stays on D1.
 * This file reuses its fonts, egress and Vite bundling, and swaps the EmDash
 * registration for `buildPlaygroundEmdashOptions`.
 */
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import emdash from "emdash/astro";
import staging from "./astro.config.ts";
import { egress } from "./astro.config.ts";
import { buildPlaygroundEmdashOptions } from "./src/playground-options.ts";

// Not wrapped in a second `defineConfig`. Spreading the storefront config
// (itself the return of `defineConfig`) back into `defineConfig` fails
// `astro check`: the widened `i18n` no longer matches the user-config
// generic. Astro loads a plain config object the same way.
const playground = {
	...staging,
	// "passthrough": the adapter's default is the paid Cloudflare Images
	// binding (`IMAGES`). The playground has no image resizing product.
	adapter: cloudflare({
		configPath: "wrangler.playground.jsonc",
		imageService: "passthrough",
	}),
	integrations: [react(), emdash(buildPlaygroundEmdashOptions(egress))],
	vite: {
		...staging.vite,
		define: {
			...staging.vite?.define,
			__OTTA_PLAYGROUND__: JSON.stringify(true),
		},
	},
};

export default playground;
