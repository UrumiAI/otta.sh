import { defineConfig } from "vitest/config";

// Otta Core's real-sandbox tier (test/workerd/): the BUILT plugin in EmDash's own
// Worker Loader runner on workerd, over miniflare D1. Not part of `pnpm test`; run
// with `pnpm -C packages/core test:sandbox` (CI: the `unit` job, after `size`).
export default defineConfig({
	test: {
		name: "core-sandbox",
		include: ["test/workerd/**/*.spec.ts"],
		// The cases are steps of ONE store's story (install, settings, product,
		// checkout, webhook, lookup, sweep), so they run in order in one file.
		sequence: { concurrent: false },
		testTimeout: 30_000,
		hookTimeout: 120_000,
	},
});
