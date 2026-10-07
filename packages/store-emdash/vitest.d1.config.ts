import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: import.meta.dirname,
	plugins: [
		cloudflareTest({
			main: "./test/d1/worker.ts",
			miniflare: {
				// The storefront's own compatibility date and flags
				// (`sites/staging/wrangler.jsonc`), so this tier runs the runtime
				// semantics the deployed site runs. A third, invented date would make a
				// divergence found here mean nothing about production.
				compatibilityDate: "2026-02-24",
				compatibilityFlags: ["nodejs_compat"],
				d1Databases: ["DB"],
			},
		}),
	],
	test: {
		name: "store-emdash-d1",
		include: ["test/d1/**/*.spec.ts"],
		// Hooks migrate a fresh database per file — the whole migration set over D1,
		// several seconds — so they get room. Cases do NOT: the long budget belongs
		// to the race case alone, which declares its own, so an ordinary case that
		// hangs fails in seconds instead of stalling the run for minutes.
		testTimeout: 30_000,
		hookTimeout: 120_000,
	},
});
