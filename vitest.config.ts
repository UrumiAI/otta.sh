import { defineConfig } from "vitest/config";

// vitest 4 removed vitest.workspace.ts; per-package projects live in
// packages/*/vitest.config.ts and are aggregated here.
export default defineConfig({
	test: {
		projects: ["packages/*/vitest.config.ts"],
		// When Postgres is enabled, run test FILES sequentially: every pg file
		// opens schema-isolated pools against ONE database, and the no-oversell
		// race alone needs a ~54-connection pool — fully parallel files can
		// spike past max_connections (default 100) and flake with "sorry, too
		// many clients already". Sequential is also FASTER here (pg contention
		// dominates the wall clock). The sqlite/fake tier keeps full
		// parallelism for the fast local loop.
		fileParallelism: process.env.PG_CONNECTION_STRING === undefined,
	},
});
