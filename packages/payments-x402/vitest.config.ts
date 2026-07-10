import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "payments-x402",
		include: ["test/**/*.test.ts"],
	},
});
