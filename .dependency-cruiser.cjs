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
		{
			name: "plugin-is-sandbox-clean",
			comment:
				"@urumi/plugin's src (loaded inside the workerd sandbox) has NO DB/" +
				"storage/filesystem/process/network-client surface — its only egress " +
				"is the injected ctx.http (DEVELOPMENT.md §5, sandbox-clean guard). " +
				"The forbidden list is a superset of domain-is-io-free's, plus " +
				"HTTP/WS client libs (undici, node-fetch, axios, ws). Test helpers " +
				"(test/) are exempt — they run in Node, driving the sandbox from " +
				"outside it. Complemented by the direct-fetch grep guard in " +
				"packages/plugin/test/sandbox-clean-guard.test.ts (depcruise can't " +
				"see ambient globals like workerd's own fetch).",
			severity: "error",
			from: { path: "^packages/plugin/src" },
			to: {
				path: "(node_modules/(pg|pg-pool|kysely|better-sqlite3|workerd|hono|node-fetch|undici|axios|ws)(/|$)|^(pg|pg-pool|kysely|better-sqlite3|workerd|hono|node-fetch|undici|axios|ws)(/|$)|^node:(fs|child_process|net|http|https|os|dgram|dns|tls|worker_threads|cluster|vm)(/|$)|^packages/(store-[^/]+|service)/)",
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
