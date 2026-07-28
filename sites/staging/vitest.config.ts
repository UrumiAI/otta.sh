/**
 * `getViteConfig` rather than a bare `defineConfig`: the theme's components are
 * `.astro` files, and Astro's experimental Container API can only render them
 * if the Astro compiler is in the Vite pipeline. That is what lets the
 * component suites assert real rendered markup — state attributes, the §7
 * totals rules, the coil's determinism — instead of grepping source text for
 * strings.
 *
 * `configFile: false` deliberately skips `astro.config.ts`. The components
 * under test use no integration, no adapter and no `astro:` virtual module, so
 * loading the Cloudflare adapter and the EmDash integration would buy nothing
 * and would put a CMS and a Workers runtime on the critical path of a unit
 * test. The pages that DO need those are covered by their own source-text
 * suites and by the browser pass.
 *
 * Note what the container does NOT give us: scoped `<style>` blocks are
 * resolved by the build pipeline, not the container, so component CSS is absent
 * from the rendered string. CSS is asserted from source text instead
 * (`component-css.test.ts`) — the same cheap pattern `tokens-css.test.ts` and
 * `base-layout.test.ts` already use.
 */
/// <reference types="vitest/config" />
import { getViteConfig } from "astro/config";

export default getViteConfig(
	{
		test: {
			name: "site-staging",
			include: ["test/**/*.test.ts"],
		},
	},
	{ configFile: false },
);
