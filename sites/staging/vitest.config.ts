import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "site-staging",
		include: ["test/**/*.test.ts"],
	},
});
