import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "example-email-provider",
		include: ["test/**/*.test.ts"],
	},
});
