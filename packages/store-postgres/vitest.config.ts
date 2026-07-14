import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "store-postgres",
		include: ["test/**/*.test.ts"],
		// Mirror the root config's guard so BOTH invocation paths (aggregated root
		// run AND `pnpm -C packages/store-postgres exec vitest`) serialize pg test
		// FILES when Postgres is enabled: every pg file opens schema-isolated pools
		// against ONE database, and the multiline no-oversell race alone needs a
		// large pool — fully parallel files can spike past max_connections and flake
		// with "sorry, too many clients already". The sqlite/fake tier (no
		// PG_CONNECTION_STRING) keeps full parallelism for the fast local loop.
		fileParallelism: process.env.PG_CONNECTION_STRING === undefined,
	},
});
