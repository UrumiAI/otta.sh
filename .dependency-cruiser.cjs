/**
 * Domain-purity boundary (DEVELOPMENT.md §3, CLAUDE.md non-negotiables).
 * `@otta-sh/domain` must depend on nothing with IO. Wired into `pnpm lint`.
 */
module.exports = {
	forbidden: [
		{
			name: "domain-is-io-free",
			comment:
				"@otta-sh/domain imports nothing with IO — no pg/kysely/better-sqlite3/hono/http, " +
				"and no dependency on adapter/service/plugin packages (DEVELOPMENT.md §3).",
			severity: "error",
			from: { path: "^packages/domain/src" },
			to: {
				// Matches the forbidden module whether it resolves into node_modules
				// (direct or pnpm-store path) or stays a bare specifier (pnpm strict
				// isolation leaves undeclared imports unresolved).
				path: "(node_modules/(pg|pg-pool|kysely|better-sqlite3|hono|node-fetch|undici)(/|$)|^(pg|pg-pool|kysely|better-sqlite3|hono|node-fetch|undici)(/|$)|^(node:)?(http|https)(/|$)|^packages/(store-[^/]+|service|plugin|payments-[^/]+)/)",
			},
		},
		{
			name: "plugin-is-sandbox-clean",
			comment:
				"@otta-sh/plugin's src (loaded inside the workerd sandbox) has NO DB/" +
				"storage/filesystem/process/network-client surface — its only egress " +
				"is the injected ctx.http (DEVELOPMENT.md §5, sandbox-clean guard). " +
				"The forbidden list is a superset of domain-is-io-free's, plus " +
				"HTTP/WS client libs (undici, node-fetch, axios, ws). It ALSO forbids " +
				"@otta-sh/domain: the plugin defines its OWN local wire types and never " +
				"imports the domain (the admin console's allowedTransitions come from " +
				"the SERVICE, not a domain import), so the ports-and-adapters boundary " +
				"stays enforced, not trusted (MOD-4). Test helpers (test/) are exempt " +
				"— they run in Node, driving the sandbox from outside it. Complemented " +
				"by the direct-fetch grep guard in " +
				"packages/plugin/test/sandbox-clean-guard.test.ts (depcruise can't " +
				"see ambient globals like workerd's own fetch). It ALSO forbids " +
				"@otta-sh/admin-react: without that, the console quarantine below is " +
				"escapable in ONE HOP — packages/plugin importing packages/admin-react " +
				"trips no rule, and react/emdash then reach the plugin transitively, " +
				"which is precisely what ADR-0014 Decision 1 forbids.",
			severity: "error",
			from: { path: "^packages/plugin/src" },
			to: {
				path: "(node_modules/(pg|pg-pool|kysely|better-sqlite3|workerd|hono|node-fetch|undici|axios|ws)(/|$)|node_modules/@otta-sh/(domain|admin-react)(/|$)|^(pg|pg-pool|kysely|better-sqlite3|workerd|hono|node-fetch|undici|axios|ws)(/|$)|^@otta-sh/(domain|admin-react)(/|$)|^node:(fs|child_process|net|http|https|os|dgram|dns|tls|worker_threads|cluster|vm)(/|$)|^packages/(store-[^/]+|service|payments-[^/]+|domain|admin-react)/)",
			},
		},
		{
			name: "console-react-is-quarantined",
			comment:
				"React and EmDash are confined to the console package (ADR-0014 " +
				"decisions 1-2). `react`/`react-dom`, `emdash` + `@emdash-cms/*`, and the " +
				"two component libraries the 2026-07-31 spike proved OPTIONAL rather than " +
				"required (`@cloudflare/kumo`, `@phosphor-icons/react`) may be imported " +
				"only from packages/admin-react. Every other package — @otta-sh/plugin " +
				"above all — keeps ZERO EmDash dependency, which is what makes a " +
				"pinned-exact EmDash upgrade unable to break it by construction, and " +
				"keeps packages/plugin/src/types.ts a hand-written mirror rather than a " +
				"re-export. ADR-0014 records that NOTHING mechanically enforced this " +
				"before: plugin-is-sandbox-clean forbids DB/Node/HTTP-client imports but " +
				"NOT `react`, and the site-config test pinned `format` but said nothing " +
				"about adminEntry. This rule is ADDITIVE — the rule above is unchanged " +
				"and still binds the same package; violating either fails `pnpm lint`. " +
				"sites/staging is deliberately out of scope (it is the EmDash HOST: it " +
				"imports `emdash` types and renders React storefront components) and " +
				"`pnpm lint` cruises `packages` only.",
			severity: "error",
			from: { path: "^packages/", pathNot: "^packages/admin-react/" },
			to: {
				// Same both-forms shape as the rules above: a resolved node_modules
				// path (direct or pnpm-store) or a bare specifier left unresolved by
				// pnpm's strict isolation.
				path: "(node_modules/(react|react-dom|emdash|@emdash-cms/[^/]+|@cloudflare/kumo|@phosphor-icons/react)(/|$)|^(react|react-dom|emdash|@emdash-cms/[^/]+|@cloudflare/kumo|@phosphor-icons/react)(/|$))",
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
