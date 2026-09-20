/**
 * Domain-purity boundary (DEVELOPMENT.md §3, CLAUDE.md non-negotiables).
 * `@otta-sh/domain` must depend on nothing with IO. Wired into `pnpm lint`.
 */
module.exports = {
	forbidden: [
		{
			name: "domain-is-io-free",
			// TODO(#291): this rule still names the deleted `service` package, in the
			// comment below and in the last clause of `to.path`. Tracked separately.
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
				"driver, filesystem, process, socket or network-client surface, and no " +
				"dependency on a SQL store or a payment adapter. Its egress " +
				"is the injected ctx.http; its commerce truth is the injected ctx.storage " +
				"(DEVELOPMENT.md §5, ADR-0018, sandbox-clean guard). The forbidden list is " +
				"a superset of domain-is-io-free's, plus HTTP/WS client libs (undici, " +
				"node-fetch, axios, ws). Test helpers (test/) are exempt — they run in " +
				"Node, driving the sandbox from outside it. Complemented by the " +
				"direct-fetch grep guard in " +
				"packages/plugin/test/sandbox-clean-guard.test.ts (depcruise can't see " +
				"ambient globals like workerd's own fetch), and executed case by case in " +
				"packages/plugin/test/depcruise-boundary.test.ts, which cruises THIS file " +
				"over planted imports and asserts the rule name each one trips. The " +
				"node-builtin half reads `^(node:)?…` because dependency-cruiser reports " +
				'`import ... from "node:fs"` under the BARE module name `fs`: a ' +
				"`^node:`-only clause matches nothing, so this rule silently permitted " +
				"every builtin it names, from the day it was written until INC-21. " +
				"`domain-is-io-free` above always had the correct form, which is why " +
				"the two rules disagreed about the same import. It still forbids " +
				"@otta-sh/admin-react, in all three spellings: without that, the console " +
				"quarantine below is escapable in ONE HOP — packages/plugin importing " +
				"packages/admin-react trips no rule, and react/emdash then reach the " +
				"plugin transitively, which is precisely what ADR-0014 Decision 1 " +
				"forbids.\n\n" +
				"TWO things this rule USED to forbid and deliberately no longer does " +
				"(ADR-0018). First, @otta-sh/domain, which was named in all three " +
				"@otta-sh clauses. The boundary was never `the plugin must not know the " +
				"domain`; it was `the plugin must not acquire IO`, and banning the domain " +
				"was a cheap PROXY for that — cheap because the domain is the package " +
				"most likely to grow an adapter import. The proxy is no longer needed and " +
				"was blocking the thing ADR-0002 designed for: the domain has zero " +
				"runtime dependencies and zero node: imports, and `domain-is-io-free` " +
				"above enforces exactly that, on every commit, as this rule's premise. " +
				"Importing the domain therefore cannot put IO inside the isolate; " +
				"importing an ADAPTER can, which is why every adapter except one stays " +
				"banned. Second, that one exception: `store-[^/]+` in the packages clause " +
				"became `(?!store-emdash/)store-[^/]+`, so packages/store-emdash is " +
				"admitted while any other store-* — including any added later — is banned " +
				"by default rather than by anyone remembering to add it — and the same list " +
				"is mirrored into the two SPECIFIER clauses, not only the packages " +
				"clause, because pnpm's strict isolation leaves an UNDECLARED import as " +
				"a bare specifier that never resolves to a packages/ path: naming only " +
				"admin-react there meant an undeclared @otta-sh/store-* " +
				"or payments-* import tripped nothing at all, which is the same class of " +
				"silent miss as the `^node:`-only builtin clause. store-emdash is " +
				"admissible because it carries no IO of its own: it is written against a " +
				"structural StorageAccess port whose implementation arrives injected, and " +
				"three store-emdash-* rules below hold it to the same perimeter as this " +
				"one, type-only imports included.\n\n" +
				"THIRD NARROWING (work order 02, INC-C1b): `payments-[^/]+` became " +
				"`(?!payments-(stripe|x402)(/|$))payments-[^/]+`, in all three clauses, " +
				"so @otta-sh/payments-stripe and @otta-sh/payments-x402 are admitted and " +
				"every other payments-* package stays banned by default. The reason is " +
				"the same shape as store-emdash's, and it is a statement about those two " +
				"packages rather than about payment adapters generally: with the service " +
				"folded in there is no second deployable to verify a Stripe webhook in, " +
				"and an UNAUTHENTICATED webhook only ever reaches a plugin route " +
				"registered `public: true` — so the HMAC verification has to happen " +
				"inside the isolate. It can: payments-stripe's verifier is WebCrypto " +
				"(`crypto.subtle.verify`, an ambient global in workerd), it imports " +
				"nothing but @otta-sh/domain, and its own sandbox-clean guard " +
				"(packages/payments-stripe/test/sandbox-clean-guard.test.ts) holds it " +
				"there. A payments adapter that reached for `pg` or a node builtin would " +
				"still be caught — by the driver and node-builtin clauses of this same " +
				"rule, which the carve-out does not touch. " +
				"packages/plugin/test/depcruise-boundary.test.ts pins both halves: these " +
				"two admitted, a third payments-* package still forbidden.\n\n" +
				"FOURTH CHANGE (work order 02, INC-D3c): `service` is no longer named in " +
				"any of the three clauses, because @otta-sh/service no longer EXISTS — " +
				"INC-D3b deleted packages/service (and packages/store-postgres with it) " +
				"once the service was folded into the plugin. A ban on a package that " +
				"cannot be imported is a clause no fixture can exercise, so it rots " +
				"silently: nothing would notice if it stopped matching, which is the same " +
				"failure mode as the `^node:`-only builtin clause above. store-postgres " +
				"was never named literally — it was caught by the " +
				"`(?!store-emdash(/|$))store-[^/]+` lookahead, which is untouched and " +
				"still bans every store-* but the one, so a store-postgres reintroduced " +
				"tomorrow is forbidden on the day it is created. A reintroduced `service` " +
				"package would NOT be, and that is deliberate: after the fold-in " +
				"(ADR-0018) a second deployable is a decision that needs its own ADR, not " +
				"something a lint rule should pre-judge on a name.",
			severity: "error",
			from: { path: "^packages/plugin/src" },
			to: {
				path: "(node_modules/(pg|pg-pool|kysely|better-sqlite3|workerd|hono|node-fetch|undici|axios|ws)(/|$)|node_modules/@otta-sh/((?!store-emdash(/|$))store-[^/]+|(?!payments-(stripe|x402)(/|$))payments-[^/]+|admin-react)(/|$)|^(pg|pg-pool|kysely|better-sqlite3|workerd|hono|node-fetch|undici|axios|ws)(/|$)|^@otta-sh/((?!store-emdash(/|$))store-[^/]+|(?!payments-(stripe|x402)(/|$))payments-[^/]+|admin-react)(/|$)|^(node:)?(fs|child_process|net|http|https|os|dgram|dns|tls|worker_threads|cluster|vm)(/|$)|^packages/((?!store-emdash(/|$))store-[^/]+|(?!payments-(stripe|x402)(/|$))payments-[^/]+|admin-react)/)",
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
				"`pnpm lint` cruises `packages` only. " +
				"@otta-sh/store-emdash is the SECOND exemption, and it is a HANDOFF to " +
				"three rules below, not a hole: that package exists to name the host's " +
				"plugin-storage types, so the blanket ban would forbid the one import it " +
				"is for. What replaces it, precisely, because 'nothing is lost' was " +
				"claimed once here and was false: `store-emdash-no-console-react` bans " +
				"react, react-dom, kumo and phosphor across the WHOLE package including " +
				"`test/` (the first split bound `src` only, which left the tests free); " +
				"`store-emdash-runs-no-host-code` bans `emdash` and @emdash-cms/* in " +
				"`src` as RUNTIME imports while permitting type-only ones; and " +
				"`store-emdash-is-sandbox-clean` adds the DB/Node/HTTP/sibling-package " +
				"perimeter this rule says nothing about. The exemption is written on " +
				"`from` rather than on `to` because dependency-cruiser cannot express one " +
				"rule whose forbidden list varies by source, and a type-only carve-out " +
				"here would have loosened the ban for admin-react and every other " +
				"package too.",
			severity: "error",
			from: { path: "^packages/", pathNot: "^packages/(admin-react|store-emdash)/" },
			to: {
				// Same both-forms shape as the rules above: a resolved node_modules
				// path (direct or pnpm-store) or a bare specifier left unresolved by
				// pnpm's strict isolation.
				path: "(node_modules/(react|react-dom|emdash|@emdash-cms/[^/]+|@cloudflare/kumo|@phosphor-icons/react)(/|$)|^(react|react-dom|emdash|@emdash-cms/[^/]+|@cloudflare/kumo|@phosphor-icons/react)(/|$))",
			},
		},
		{
			name: "store-emdash-no-console-react",
			comment:
				"The console quarantine, restated for the ONE package whose `from` " +
				"`console-react-is-quarantined` exempts. That exemption exists because " +
				"the blanket ban names `emdash`, which is the one import " +
				"@otta-sh/store-emdash is FOR — but react has nothing to do with that, " +
				"and losing the react ban as a side effect of the EmDash carve-out would " +
				"be exactly the silent hole ADR-0014 Decision 1 forbids. So this rule " +
				"binds the WHOLE package, `test/` included: unlike the IO rule below, " +
				"there is no version of importing react here that is legitimate in a " +
				"Node test, and the first version of this split bound `src` only and " +
				"left `test/**` free to import react, react-dom, kumo and phosphor with " +
				"nothing catching it. Deliberately carries NO `dependencyTypesNot`: a " +
				"type-only react import is a signal that a component is being written " +
				"where none belongs, and it costs nothing to refuse.",
			severity: "error",
			from: { path: "^packages/store-emdash/" },
			to: {
				// Both spellings, as in every rule here: resolved into node_modules
				// (direct or via the pnpm store), or left a bare specifier by pnpm's
				// strict isolation.
				path: "(node_modules/(react|react-dom|@cloudflare/kumo|@phosphor-icons/react)(/|$)|^(react|react-dom|@cloudflare/kumo|@phosphor-icons/react)(/|$))",
			},
		},
		{
			name: "store-emdash-is-sandbox-clean",
			comment:
				"@otta-sh/store-emdash's src is commerce-truth code that runs INSIDE the " +
				"workerd sandbox, bound to the `ctx.storage` the host injects. It " +
				"therefore carries the same perimeter as `plugin-is-sandbox-clean`: no " +
				"DB driver, no filesystem/process/socket builtin, no HTTP or WS client, " +
				"no sibling server package. Type-only imports are NOT exempt here, and " +
				"the exemption is not a detail: `dependencyTypesNot` on a whole `to` " +
				'clause would have permitted `import type { Pool } from "pg"` and ' +
				'`import type { Stats } from "node:fs"`, which are how a module starts ' +
				"being written against a host it must never touch. Only the EmDash " +
				"clause below gets that allowance, and it gets it precisely because it " +
				"is the seam. Sibling store packages are matched by negative lookahead " +
				"rather than by name, so a future store-d1 is banned on the day it is " +
				"created instead of the day someone remembers this list. Test code is " +
				"exempt, as it is for every rule here — `test/describe-each-dialect.ts` " +
				"runs in NODE and constructs real `PluginStorageRepository` instances " +
				"over better-sqlite3 and Postgres on purpose: real databases, never " +
				"mocks. That harness is why the ban can be this strict in `src` without " +
				"costing coverage. (`react` and friends are banned across the whole " +
				"package by `store-emdash-no-console-react` above.) @otta-sh/plugin is " +
				"banned here too, in all three spellings, and that half is about LAYERING " +
				"rather than IO: the plugin is what injects ctx.storage into this " +
				"package, so an import in this direction would make the adapter depend on " +
				"its own caller. Nothing else caught the inversion — `plugin-is-sandbox-" +
				"clean` admits store-emdash, this rule said nothing about the plugin, and " +
				"the console rules bind neither package — so the cycle would have been " +
				"a review catch rather than a build failure. Sibling adapters, the service " +
				"and the payment packages are likewise named in all three spellings " +
				"rather than in the packages clause alone, for the bare-specifier reason " +
				"the plugin rule's comment sets out. Every case this rule and " +
				"the plugin rule turn on are executed in " +
				"packages/plugin/test/depcruise-boundary.test.ts.",
			// TODO(#291): this rule still names the deleted `service` package, in the
			// comment above and in three clauses of `to.path`. Tracked separately.
			severity: "error",
			from: { path: "^packages/store-emdash/src" },
			to: {
				// Both spellings, as above. The builtin half is the optional-`node:`
				// form the plugin rule's comment explains — dependency-cruiser reports
				// `from "node:fs"` under the bare name `fs`.
				path: "(node_modules/(pg|pg-pool|kysely|better-sqlite3|workerd|hono|node-fetch|undici|axios|ws)(/|$)|node_modules/@otta-sh/((?!store-emdash(/|$))store-[^/]+|service|payments-[^/]+|admin-react|plugin)(/|$)|^(pg|pg-pool|kysely|better-sqlite3|workerd|hono|node-fetch|undici|axios|ws)(/|$)|^@otta-sh/((?!store-emdash(/|$))store-[^/]+|service|payments-[^/]+|admin-react|plugin)(/|$)|^(node:)?(fs|child_process|net|http|https|os|dgram|dns|tls|worker_threads|cluster|vm)(/|$)|^packages/(service|payments-[^/]+|admin-react|plugin)/|^packages/(?!store-emdash(/|$))store-[^/]+/)",
			},
		},
		{
			name: "store-emdash-runs-no-host-code",
			comment:
				"The seam, as a rule. @otta-sh/store-emdash may NAME EmDash's storage " +
				"types and may never EXECUTE EmDash's code: `src/storage-access.ts` is " +
				"written in terms of the host's `StorageCollection` and its conditional-" +
				"write result types, and the implementation arrives injected — " +
				"`ctx.storage` in production, a real `PluginStorageRepository` in the " +
				"harness. That is what makes replacing the host build a dependency " +
				"change rather than an adapter rewrite. `dependencyTypesNot: " +
				"['type-only']` is the whole rule: a type import emits no code and " +
				"cannot put host behaviour inside the isolate, while a runtime import of " +
				"the same module fails the build. It is a SEPARATE rule from " +
				"`store-emdash-is-sandbox-clean` for exactly that reason — the " +
				"allowance is specific to the host and must not leak onto the IO bans, " +
				"which is what a single merged clause did in the first version. " +
				"`^emdash$|^emdash/` rather than a bare prefix, so a package merely " +
				"NAMED like the host is not swept in.",
			severity: "error",
			from: { path: "^packages/store-emdash/src" },
			to: {
				path: "(node_modules/(emdash|@emdash-cms/[^/]+)(/|$)|^emdash$|^emdash/|^@emdash-cms/)",
				// The one allowance in this package's perimeter, and the reason the
				// structural port can be written against the host's own types instead
				// of a hand-mirrored copy left to drift.
				dependencyTypesNot: ["type-only"],
			},
		},
		{
			name: "admin-presentation-is-dependency-free",
			comment:
				"@otta-sh/admin-presentation may import NOTHING but its own relative " +
				"modules. It is the ONE package imported by BOTH a module bundled " +
				"into workerd (@otta-sh/plugin, from a bare scratch copy of src/ " +
				"with no workspace node_modules) AND a module that ships to a " +
				"browser (@otta-sh/admin-react). Nothing else in this workspace is " +
				"safe in both, and neither host would fail at lint or at typecheck: " +
				"a `node:fs` here typechecks, cruises clean under every OTHER rule, " +
				"and fails inside the isolate at runtime; a `pg` here would be a " +
				"database driver in an admin page's JS bundle. Both were PLANTED " +
				"during the INC-20 review and both passed, which is why this rule " +
				"exists as a rule rather than as a sentence in the package's own " +
				"doc comment. The allow-list is deliberately empty — not `only node: " +
				"builtins`, not `only type imports` — because the package's whole " +
				"value is that it has no host requirements at all. Test code is " +
				"exempt, as it is for every rule here: it runs in Node, outside the " +
				"shipped surface. `packages/admin-presentation/test/` reads its own " +
				"sources with node:fs to assert this same property from the inside, " +
				"and that file is not the shipped surface.",
			severity: "error",
			from: { path: "^packages/admin-presentation/src" },
			to: {
				// Everything that is not a relative specifier inside this package:
				// any node: builtin, any bare package name, any other workspace path.
				pathNot: "^packages/admin-presentation/src",
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
				"packages (domain/store/payments), Node and database code " +
				"reached from a module that ships to a BROWSER. So: no workspace " +
				"package, in either direction. The consequence is deliberate and has " +
				"one known bill to pay — INC-20 owes the React tier a formatMoney, and " +
				"G1 says it must come from SHARING the existing function (a new " +
				"presentation package both sides import), never from writing a second " +
				"one. Test code is exempt for the same reason it is exempt above: it " +
				"runs in Node, outside the shipped surface. INC-20 PAID that bill, " +
				"and paying it is the one carve-out below: " +
				"@otta-sh/admin-presentation holds formatMoney and its brands, the " +
				"console's single date dialect, the short-id rule and the " +
				"order-status vocabulary — everything the two admin surfaces must " +
				"agree on when rendering the same record. It is NOT a second data " +
				"path: zero dependencies, zero IO, zero wire types, zero react, zero " +
				"emdash, pure Intl and string work, which is what makes it safe both " +
				"in a browser and inside workerd (@otta-sh/plugin imports it too, so " +
				"the plugin's own suites prove the two surfaces cannot drift). Every " +
				"OTHER workspace package stays forbidden, in either direction.",
			severity: "error",
			from: { path: "^packages/admin-react/src" },
			to: {
				// Both forms, as above: resolved into node_modules (the workspace
				// link) or left as a bare specifier by pnpm's strict isolation. The
				// lookaheads carve out admin-presentation in each spelling a cruise
				// can produce. A lookalike such as `@otta-sh/admin-presentation-shim`
				// is still caught, because the lookahead requires the name to END
				// there — at a `/` or at the end of the specifier.
				path: "(node_modules/@otta-sh/(?!admin-presentation(/|$))[^/]+(/|$)|^@otta-sh/(?!admin-presentation(/|$))[^/]+(/|$)|^packages/(?!admin-react/|admin-presentation/))",
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
			// `.tsx` is here for packages/admin-react, the one package in the
			// workspace that compiles JSX. It is for GRAPH COMPLETENESS, and it
			// is worth being precise about what it does NOT do, because the
			// first version of this comment claimed the opposite and was wrong.
			//
			// It is NOT what enforces the quarantine. dependency-cruiser walks
			// `.tsx` source regardless of this list, so `admin.tsx`'s own imports
			// are cruised and `console-imports-no-workspace-package` fires on a
			// planted `@otta-sh/plugin` import with or without the entry —
			// verified both ways, not assumed.
			//
			// What it actually closes is one phantom unresolved edge:
			// `test/console-plugin.test.ts`'s `../src/admin.js` (the repo's `.js`
			// internal-import convention) resolving to `admin.tsx`. That edge
			// lives in `test/`, which every rule here exempts, so nothing is
			// gated on it — an unresolved dependency is simply noise in the graph
			// that a future `no-orphans`-style rule would trip over.
			extensions: [".ts", ".tsx", ".js"],
		},
	},
};
