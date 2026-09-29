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
		// PINNED (it is vitest's default): each test file gets fresh module state,
		// so the sandbox storage bridge — one store per module instance — is per
		// FILE. `storefront-checkout.sandbox.test.ts` asserts "no shipping zone in
		// the store" outside its #305 describes on exactly that basis.
		isolate: true,
	},
});
