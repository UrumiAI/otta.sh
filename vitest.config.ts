import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// The suite is pinned to the Node major in `.nvmrc`, the one CI runs (#478). On
// Node 26 four tests fail: its newer URL parser accepts `xn--localhost.com`, and
// its better-sqlite3 binds a lone surrogate as U+FFFD where SQLite's JSON
// functions keep it raw, so a SQLite lookup by a legacy lone-surrogate value
// misses its row. The second is a real difference for a SQLite store on Node 26,
// tracked on #478, not a flaky test. `OTTA_ANY_NODE=1` runs anyway.
const pinnedNode = readFileSync(new URL(".nvmrc", import.meta.url), "utf8").trim();
const runningNode = process.versions.node.split(".")[0];
if (runningNode !== pinnedNode && process.env.OTTA_ANY_NODE !== "1") {
	throw new Error(
		`Otta's tests run on Node ${pinnedNode} (.nvmrc, as in CI); this is Node ` +
			`${process.versions.node}. Switch with \`nvm use\`, or set OTTA_ANY_NODE=1 to run anyway.`,
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
