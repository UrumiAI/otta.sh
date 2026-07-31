/**
 * The `otta-console` descriptor's package-side surface — identity, pages, and
 * the native `createPlugin()` factory EmDash calls at build time.
 *
 * WHAT THIS PACKAGE IS. ADR-0014 amends ADR-0006 Decision 2 by exactly one
 * thing: React admin pages, on a SECOND EmDash descriptor, in a SEPARATE
 * package. This is that package. `@otta-sh/plugin` is untouched by it — still
 * `format: "standard"`, still sandbox-clean, still zero EmDash dependency, and
 * `packages/plugin/src/types.ts` stays a hand-written mirror.
 *
 * WHY TWO IDS. Sidebar visibility is derived PER PLUGIN ID: one `adminMode` per
 * plugin, `"react"` the moment `admin.entry` exists, after which the sidebar
 * shows only that plugin's pages having a React component
 * (`@emdash-cms/admin@0.31.1`, sidebar builder: `if (!isBlocksMode &&
 * !resolvePluginPagePath(pluginPages, page.path)) continue;`). One React page
 * added under id `otta` would therefore make its seven Block Kit screens vanish
 * from the sidebar while still rendering at their URLs. The second id avoids
 * that by construction — ADR-0014 Decision 7.
 *
 * NO REACT IN THIS MODULE. The site imports it to build the descriptor, so it
 * is bundled into the Cloudflare Worker; `./admin` (the React half) is imported
 * only by EmDash's generated admin registry and lands in client assets. Keeping
 * the two apart is why the Worker cost of the whole arrangement is a fraction
 * of a KiB. Do not import `./admin.tsx` from here.
 */
import type { PluginAdminPage, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";

/** ADR-0014's second descriptor id. Never `otta` — see the module doc. */
export const OTTA_CONSOLE_PLUGIN_ID = "otta-console";

export const OTTA_CONSOLE_PLUGIN_VERSION = "0.0.1";

/**
 * This package's name, as EmDash's generated virtual modules will write it.
 *
 * Both module specifiers below are derived from it rather than spelled out, so
 * a rename cannot leave one of them pointing at a package that no longer
 * exists — and so `sites/staging/test/site-config.test.ts`'s boundary check
 * (both specifiers must resolve INTO this package, and a lookalike such as
 * `@otta-sh/admin-react-shim` must not pass) has a single thing to hold.
 */
export const OTTA_CONSOLE_PACKAGE = "@otta-sh/admin-react";

/** `PluginDescriptor.entrypoint` — EmDash generates
 *  `import { createPlugin } from "<this>"` and calls it (native format). */
export const OTTA_CONSOLE_ENTRYPOINT = OTTA_CONSOLE_PACKAGE;

/** `PluginDescriptor.adminEntry` — EmDash generates
 *  `import * as admin from "<this>"` into the admin registry, and reads
 *  `pages` off it. */
export const OTTA_CONSOLE_ADMIN_ENTRY = `${OTTA_CONSOLE_PACKAGE}/admin`;

/**
 * The console's landing page.
 *
 * INC-19 ships the SHELL, not a migrated screen: Orders arrives in INC-20 at
 * `/orders` and Pricing & inventory in INC-21 at `/products`, each replacing a
 * Block Kit screen that stays in the tree and stays green until it does. Tax,
 * Shipping and Settings never migrate (ADR-0014 Decision 6).
 *
 * The path is explicit rather than `"/"`. The admin router builds a page path
 * from a splat (`"/" + (_splat || "")`), so `"/"` is reachable, but it makes
 * the console's nav entry the only one in the sidebar whose href ends in a bare
 * slash — a shape Astro's trailing-slash handling has an opinion about and this
 * increment has no reason to test.
 */
export const CONSOLE_HOME_PAGE = {
	path: "/console",
	label: "Console",
	icon: "browsers",
} as const satisfies PluginAdminPage;

/**
 * Every page the console declares.
 *
 * A path listed here MUST have a component under the same key in `./admin`'s
 * `pages` export, or the sidebar silently drops the entry (the resolver quoted
 * in the module doc). `test/console-plugin.test.ts` pins the two together.
 */
export const OTTA_CONSOLE_ADMIN_PAGES: readonly PluginAdminPage[] = [CONSOLE_HOME_PAGE];

/**
 * The native entrypoint. EmDash's generated plugins module does
 * `import { createPlugin } from "@otta-sh/admin-react"` and calls it; the
 * returned `ResolvedPlugin` is what `configuredPlugins` holds, and it is
 * `admin.entry` HERE — not `descriptor.adminEntry` — that makes the runtime
 * derive `adminMode: "react"` for THIS plugin id only.
 *
 * It declares no hooks, no routes, no storage and `capabilities: []`
 * (ADR-0014 Decision 3). The console has no server-side surface at all: it is
 * a browser page that calls `otta`'s admin route with the operator's own
 * session. `options` is accepted and ignored — the descriptor passes none, and
 * ADR-0006's "no `options`-configured native format" prohibition stands
 * unamended.
 */
export function createPlugin(_options: Record<string, unknown> = {}): ResolvedPlugin {
	return definePlugin({
		id: OTTA_CONSOLE_PLUGIN_ID,
		version: OTTA_CONSOLE_PLUGIN_VERSION,
		capabilities: [],
		admin: {
			entry: OTTA_CONSOLE_ADMIN_ENTRY,
			pages: [...OTTA_CONSOLE_ADMIN_PAGES],
		},
	});
}

export default createPlugin;
