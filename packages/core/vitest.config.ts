import { defineConfig } from "vitest/config";

// With PG_CONNECTION_STRING set the harness runs EmDash's Postgres dialect on a
// fresh database per test (CREATE DATABASE ... TEMPLATE), which is far slower than
// in-memory SQLite on a shared CI runner, so the timeouts are raised for that tier only.
const pg = Boolean(process.env["PG_CONNECTION_STRING"]);

export default defineConfig({
	test: {
		name: "core",
		include: ["test/**/*.test.ts", "storefront/**/*.test.ts"],
		...(pg ? { testTimeout: 30_000, hookTimeout: 60_000 } : {}),
	},
});
