/**
 * The React admin console's page registry — the whole of `otta-console`'s UI.
 *
 * WHAT THIS PACKAGE IS. A `format: "native"` descriptor renders React pages in
 * the EmDash admin while the `otta` Block Kit descriptor keeps its own screens
 * and its own sidebar group (ADR-0014 Decision 7 — the `adminMode` granularity
 * trap). Two descriptor ids, one admin.
 *
 * WHAT LIVES HERE. INC-20 migrated Orders (`./orders/`) and INC-21 migrated
 * Pricing & inventory (`./products/`) — every screen ADR-0014 Decision 6 puts in
 * scope. INC-19's diagnostic landing page is gone: it managed no data, and the
 * one thing it proved — that a page served under `otta-console` can call the
 * `otta` plugin's admin route and get a 200 (ADR-0014 Decision 3's only data
 * path) — is now proved by the two real screens, which do nothing else for
 * every row they render. Its sidebar-group evidence was not lost with it; that
 * spec was re-homed onto Orders rather than deleted.
 *
 * NO COMPONENT LIBRARY. `@cloudflare/kumo` and `@phosphor-icons/react` were
 * measured UNRESOLVABLE and unnecessary on the spike; `@emdash-cms/plugin-forms`
 * uses them by choice, not by requirement. Adopting either would be a
 * deliberate new coupling to an unpinned component library (ADR-0014,
 * "what becomes harder"), and it is not taken. Inline styles only — and only
 * ones that survive the admin's dark theme, so no fixed foreground or
 * background colours.
 *
 * MONEY. G1 says money is integer minor units rendered through `formatMoney`,
 * and this package cannot import `@otta-sh/plugin` (ADR-0014 Decision 3 / the
 * depcruise quarantine). The function is SHARED rather than reimplemented: it
 * lives in `@otta-sh/admin-presentation`, a dependency-free package both admin
 * surfaces import. There is still no second money renderer anywhere in this
 * repo.
 *
 * THE ONE DATA PATH lives in `./console-api.ts`, and `OTTA_ADMIN_ROUTE` is
 * declared there, once. This module holds no transport of its own.
 */
import type { PluginAdminExports } from "emdash";
import { OrdersScreen } from "./orders/orders-screen.js";
import { ProductsScreen } from "./products/products-screen.js";

/**
 * EmDash types `PluginAdminExports["pages"]` as `Record<string, JSX.Element>`
 * while the admin router calls the value as a COMPONENT
 * (`const PluginComponent = usePluginPage(...); <PluginComponent />`). The
 * shipped `@emdash-cms/plugin-forms` has the same mismatch and casts too.
 *
 * EVERY KEY MUST EQUAL THE `path` OF THE MATCHING ENTRY in
 * `OTTA_CONSOLE_ADMIN_PAGES` (`./index.ts`) — `ORDERS_PAGE.path` and
 * `PRODUCTS_PAGE.path` — or the sidebar drops the entry without an error;
 * `test/console-plugin.test.ts` pins the two lists together in both directions.
 */
export const pages = {
	"/orders": OrdersScreen,
	"/products": ProductsScreen,
} as unknown as PluginAdminExports["pages"];
