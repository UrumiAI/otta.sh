import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "admin-react",
		include: ["test/**/*.test.ts"],
	},
});
