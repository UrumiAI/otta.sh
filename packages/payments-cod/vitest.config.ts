import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "payments-cod",
		include: ["test/**/*.test.ts"],
	},
});
