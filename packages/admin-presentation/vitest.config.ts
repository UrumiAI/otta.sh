import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "admin-presentation",
		include: ["test/**/*.test.ts"],
	},
});
