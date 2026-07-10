import { defineConfig } from "vitest/config";

// vitest 4 removed vitest.workspace.ts; per-package projects live in
// packages/*/vitest.config.ts and are aggregated here.
export default defineConfig({
	test: {
		projects: ["packages/*/vitest.config.ts"],
	},
});
