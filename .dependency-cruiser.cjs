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
		{
			name: "console-imports-no-workspace-package",
			comment:
				"The OTHER half of the console quarantine, and the one the rules above " +
				"do not cover. `plugin-is-sandbox-clean` forbids packages/plugin from " +
				"importing @otta-sh/admin-react; nothing forbade the reverse, and the " +
				"reverse is the direction that actually tempts an implementer — " +
				"`formatMoney`, the wire types, the short-id helper all sit in " +
				"@otta-sh/plugin and all look reusable. ADR-0014 Decision 3 gives " +
				"otta-console EXACTLY ONE data path: HTTP to the existing " +
				"authenticated `otta` admin routes, with the operator's own session. A " +
				"static import would be a second one — compiled in, invisible to the " +
				"empty capability set and to the empty allowedHosts that are this " +
				"descriptor's only declared controls. It is also, for the server " +
				"packages (domain/service/store/payments), Node and database code " +
				"reached from a module that ships to a BROWSER. So: no workspace " +
				"package, in either direction. The consequence is deliberate and has " +
				"one known bill to pay — INC-20 owes the React tier a formatMoney, and " +
				"G1 says it must come from SHARING the existing function (a new " +
				"presentation package both sides import), never from writing a second " +
				"one. Test code is exempt for the same reason it is exempt above: it " +
				"runs in Node, outside the shipped surface.",
			severity: "error",
			from: { path: "^packages/admin-react/src" },
			to: {
				// Both forms, as above: resolved into node_modules (the workspace
				// link) or left as a bare specifier by pnpm's strict isolation.
				path: "(node_modules/@otta-sh/[^/]+(/|$)|^@otta-sh/[^/]+(/|$)|^packages/(?!admin-react/))",
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
			// `.tsx` is here for packages/admin-react — the one package in the
			// workspace that compiles JSX. Without it the console's `./admin`
			// export resolves to nothing and the quarantine rules pass vacuously
			// over the exact file they exist to police.
			extensions: [".ts", ".tsx", ".js"],
		},
	},
};
