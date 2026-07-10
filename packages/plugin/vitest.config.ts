import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "plugin",
		include: ["test/**/*.test.ts"],
		// The workerd sandbox harness spawns a real child process and
		// bundles the plugin per test file; give it more headroom than the
		// default.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
