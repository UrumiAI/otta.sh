/**
 * Domain-purity boundary (DEVELOPMENT.md §3, CLAUDE.md non-negotiables).
 * `@urumi/domain` must depend on nothing with IO. Wired into `pnpm lint`.
 */
module.exports = {
	forbidden: [
		{
			name: "domain-is-io-free",
			comment:
				"@urumi/domain imports nothing with IO — no pg/kysely/better-sqlite3/hono/http, " +
				"and no dependency on adapter/service/plugin packages (DEVELOPMENT.md §3).",
			severity: "error",
			from: { path: "^packages/domain/src" },
			to: {
				// Matches the forbidden module whether it resolves into node_modules
				// (direct or pnpm-store path) or stays a bare specifier (pnpm strict
				// isolation leaves undeclared imports unresolved).
				path: "(node_modules/(pg|pg-pool|kysely|better-sqlite3|hono|node-fetch|undici)(/|$)|^(pg|pg-pool|kysely|better-sqlite3|hono|node-fetch|undici)(/|$)|^(node:)?(http|https)(/|$)|^packages/(store-[^/]+|service|plugin)/)",
			},
		},
	],
	options: {
		doNotFollow: { path: "node_modules" },
		tsPreCompilationDeps: true,
		tsConfig: { fileName: "tsconfig.json" },
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "types", "default"],
			extensions: [".ts", ".js"],
		},
	},
};
