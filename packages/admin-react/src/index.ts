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
 * added under id `otta` would therefore make its five Block Kit screens vanish
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
 * The migrated Orders screen (INC-20) — the console's first real screen and the
 * effort's flagship migration.
 *
 * THE ONLY ORDERS SCREEN, as of INC-R2. It used to be one of two: the Block Kit
 * screen declared `/orders` on the `otta` descriptor and this one declares it on
 * `otta-console`, which never collided because a page's URL carries its plugin id
 * (`…/plugins/otta/orders` versus `…/plugins/otta-console/orders`). Identical
 * paths were what let an operator compare the two by swapping one segment while
 * both rendered — ADR-0014 Decision 1's parallel period. ADR-0015 ended it: the
 * Block Kit screen is gone, so the path is now simply this screen's path and there
 * is nothing left to compare it against.
 *
 * WHICH IS WHY THE LABEL IS PLAIN `Orders`. It read `Orders (new)` for the whole
 * parallel period, because two sidebar entries reading `Orders` with nothing to
 * tell them apart would have been the worst outcome of the two-descriptor
 * arrangement. With the original gone, `(new)` is the misleading thing — a single
 * entry marked new against nothing (ADR-0015 Decision 1).
 *
 * Pricing & inventory's page reached the same state one increment later, for the
 * same reason and under the same clause, before it left the sidebar altogether.
 */
export const ORDERS_PAGE = {
	path: "/orders",
	label: "Orders",
	icon: "receipt",
} as const satisfies PluginAdminPage;

/*
 * There is no Pricing & inventory PAGE any more. INC-21 migrated it here and
 * ADR-0014's amendment of 2026-10-01 moved it again, into the products
 * collection's own editor (Pricing & stock cards) and list (Price and Stock
 * columns) — see `./admin.tsx`. A merchant prices a product where they wrote it,
 * and the sidebar no longer offers a second "products" screen under Plugins.
 */
/**
 * The storefront Themes screen (ADR-0014, amended 2026-09-30): a screenshot
 * grid with live preview and activate — WordPress's Appearance → Themes for
 * this store. The first console screen that is NOT a migration: it has no Block
 * Kit original to retire, only a fallback (the Settings "Store theme" radio)
 * that stays. It is React because Block Kit cannot draw it (no image card, no
 * hover, no link, no frame), a ruling the amendment records.
 *
 * `palette` is a Phosphor icon name the admin sidebar resolves, like `receipt`
 * and `box` above.
 */
export const THEMES_PAGE = {
	path: "/themes",
	label: "Themes",
	icon: "palette",
} as const satisfies PluginAdminPage;

/** The field editors this plugin contributes. A products field declared with
 *  `widget: "otta-console:pricing"` renders the Pricing & stock cards. */
export const OTTA_CONSOLE_FIELD_WIDGETS = [
	{ name: "pricing", label: "Pricing & stock", fieldTypes: ["json"] },
] as const;

/**
 * Every page the console declares.
 *
 * A path listed here MUST have a component under the same key in `./admin`'s
 * `pages` export, or the sidebar silently drops the entry (the resolver quoted
 * in the module doc). `test/console-plugin.test.ts` pins the two together, and
 * `sites/staging/test/site-config.test.ts` pins every entry to a Playwright
 * gate.
 */
export const OTTA_CONSOLE_ADMIN_PAGES: readonly PluginAdminPage[] = [ORDERS_PAGE, THEMES_PAGE];

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
			// The products editor's Pricing & stock cards: a React field editor
			// (`./admin.tsx`'s `fields.pricing`), declared in the manifest for
			// completeness (ADR-0014, amendment 2026-10-01). EmDash 0.38's Content
			// Types screen cannot bind a widget; the seed and
			// `sites/staging/scripts/add-pricing-field.ts` do.
			fieldWidgets: OTTA_CONSOLE_FIELD_WIDGETS.map((widget) => ({
				...widget,
				fieldTypes: [...widget.fieldTypes],
			})),
		},
	});
}

export default createPlugin;
