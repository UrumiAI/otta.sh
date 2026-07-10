import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "store-postgres",
		include: ["test/**/*.test.ts"],
	},
});
