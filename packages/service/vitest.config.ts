import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "service",
		include: ["test/**/*.test.ts"],
	},
});
