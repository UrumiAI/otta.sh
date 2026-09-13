import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "store-emdash",
		include: ["test/**/*.test.ts"],
		// Mirror the root config's guard so BOTH invocation paths (the aggregated
		// root run AND `pnpm -C packages/store-emdash exec vitest`) serialize pg
		// test FILES when Postgres is enabled: every pg file creates its own
		// schema and pool against ONE database, and the conditional-write race
		// opens a pool per attempt — fully parallel files can spike past
		// max_connections and flake with "sorry, too many clients already". The
		// sqlite tier (no PG_CONNECTION_STRING) keeps full parallelism for the
		// fast local loop.
		fileParallelism: process.env.PG_CONNECTION_STRING === undefined,
	},
});
