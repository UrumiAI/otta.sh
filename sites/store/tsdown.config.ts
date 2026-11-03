import { defineConfig } from "tsdown";

/**
 * ONE compiled entry: the integration (ADR-0045). Astro loads a site's
 * `astro.config.*` through Node, which does not strip types from files under
 * `node_modules`, so the module that config imports must be JavaScript. It
 * bundles the build-time helpers it imports from `src/lib` (the guards, the
 * scrub, the EmDash options); every package dependency stays a bare import.
 *
 * Everything the integration points Astro at — pages, middleware, worker,
 * theme — ships as SOURCE (`files`: `src`) and is compiled by the site's Vite
 * build, which is also what applies the plugin's build-time defines.
 */
export default defineConfig({
	entry: ["src/integration.ts"],
	format: ["esm"],
	platform: "node",
	sourcemap: false,
	dts: true,
	clean: true,
});
