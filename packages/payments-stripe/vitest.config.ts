import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "payments-stripe",
		include: ["test/**/*.test.ts"],
	},
});
