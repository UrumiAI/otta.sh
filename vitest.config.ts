import { defineConfig } from "vitest/config";

// Node 26 and later are refused (#478): four tests fail there. Its newer URL
// parser accepts `xn--localhost.com`, and its better-sqlite3 binds a lone
// surrogate as U+FFFD where SQLite's JSON functions keep it raw, so a SQLite
// lookup by a legacy lone-surrogate value misses its row. Both are test-only:
// better-sqlite3 is a devDependency, and production runs on Workers (D1) or
// Postgres. CI runs the major in `.nvmrc`; 22 and 24 run without a word.
// `OTTA_ANY_NODE=1` runs anyway (see DEVELOPMENT.md §6).
const FIRST_REFUSED_NODE_MAJOR = 26;
const runningNode = Number(process.versions.node.split(".")[0]);
if (runningNode >= FIRST_REFUSED_NODE_MAJOR && process.env.OTTA_ANY_NODE !== "1") {
	throw new Error(
		`Otta's tests do not run on Node ${String(FIRST_REFUSED_NODE_MAJOR)} or later yet (this is ` +
			`Node ${process.versions.node}); CI uses the major in .nvmrc. Switch with \`nvm use\`, ` +
			"or set OTTA_ANY_NODE=1 to run anyway (four known failures, see #478).",
	);
}

// vitest 4 removed vitest.workspace.ts; per-package projects live in
// packages/*/vitest.config.ts and are aggregated here.
export default defineConfig({
	test: {
		projects: [
			"packages/*/vitest.config.ts",
			"sites/*/vitest.config.ts",
			"examples/*/vitest.config.ts",
		],
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
