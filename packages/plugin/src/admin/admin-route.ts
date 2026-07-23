import type { RouteHandler, SandboxedRouteContext } from "../types.js";
import {
	createOrdersPageHandler,
	ORDERS_ACTION_IDS,
	ORDERS_PAGE,
	type OrdersPageInput,
} from "./orders-page.js";
import {
	createProductsPageHandler,
	PRODUCTS_ACTION_IDS,
	PRODUCTS_PAGE,
	type ProductsPageInput,
} from "./products-page.js";
import { createReportsPageHandler, REPORTS_PAGE, type ReportsPageInput } from "./reports-page.js";
import {
	createSettingsFormHandler,
	SETTINGS_ACTION_IDS,
	SETTINGS_PAGE,
	type SettingsFormInput,
} from "./settings-form.js";
import { createTaxPageHandler, TAX_ACTION_IDS, TAX_PAGE, type TaxPageInput } from "./tax-page.js";

/**
 * The SINGLE admin route em-dash's admin shell dispatches to. EmDash renders
 * every plugin admin page by `POST /plugins/{id}/admin` with a `BlockInteraction`
 * body (`{type:"page_load", page:"/reports"}`, a `{type:"block_action", action_id,
 * …}`, or a `{type:"form_submit", action_id, values}`), and looks the route up by
 * the literal key `"admin"` (`~/em-dash/packages/core/src/plugins/routes.ts`
 * → 404 `ROUTE_NOT_FOUND` if missing). This is why per-page keys like
 * `"admin/reports"` never resolve — the canonical pattern is ONE `admin` route
 * that dispatches on `type` + `page`/`action_id`, exactly like em-dash's own
 * audit-log (`plugin.ts:194`) and atproto (`plugin.ts:506`) plugins.
 */
export const ADMIN_ROUTE = "admin";

/** The em-dash `BlockInteraction` envelope, narrowed to the fields the
 *  dispatcher reads. Sub-handlers receive the SAME `routeCtx` unchanged and
 *  each validate their own richer input shape. */
interface AdminInteractionInput {
	type?: unknown;
	page?: unknown;
	action_id?: unknown;
}

/**
 * Build the single `admin` route handler. Constructs the Reports + Settings
 * sub-handlers ONCE, then returns a dispatcher that forwards the UNCHANGED
 * `routeCtx`/`ctx` to the chosen sub-handler.
 *
 * This module is IO-FREE — pure control flow. All IO (ctx.http / ctx.kv) stays
 * inside the sub-handlers, keeping the sandbox-clean guard green (no bare
 * network-egress token appears in this file).
 */
export function createAdminRouteHandler(): RouteHandler<AdminInteractionInput> {
	const reports = createReportsPageHandler();
	const settings = createSettingsFormHandler();
	const orders = createOrdersPageHandler();
	const products = createProductsPageHandler();
	const tax = createTaxPageHandler();

	return async (routeCtx, ctx) => {
		const input = routeCtx.input;
		const type = typeof input.type === "string" ? input.type : undefined;
		const page = typeof input.page === "string" ? input.page : undefined;
		const actionId = typeof input.action_id === "string" ? input.action_id : undefined;

		// 1–4. GATE page branches on `type === "page_load"` (em-dash's reference
		// returns blocks-empty for a block_action that happens to carry a page).
		if (type === "page_load" && page === REPORTS_PAGE.path) {
			return reports(routeCtx as SandboxedRouteContext<ReportsPageInput>, ctx);
		}
		if (type === "page_load" && page === SETTINGS_PAGE.path) {
			return settings(routeCtx as SandboxedRouteContext<SettingsFormInput>, ctx);
		}
		if (type === "page_load" && page === ORDERS_PAGE.path) {
			return orders(routeCtx as SandboxedRouteContext<OrdersPageInput>, ctx);
		}
		if (type === "page_load" && page === PRODUCTS_PAGE.path) {
			return products(routeCtx as SandboxedRouteContext<ProductsPageInput>, ctx);
		}
		if (type === "page_load" && page === TAX_PAGE.path) {
			return tax(routeCtx as SandboxedRouteContext<TaxPageInput>, ctx);
		}

		// 5. Action interactions (block_action/form_submit) carry an action_id and
		// no page — route each page's actions to its handler. Every Orders/Products
		// action is namespaced `orders:*`/`products:*` and listed in
		// ORDERS_ACTION_IDS/PRODUCTS_ACTION_IDS (MOD-2), so none falls through to
		// the blocks-empty fallback below.
		if (actionId !== undefined && SETTINGS_ACTION_IDS.has(actionId)) {
			return settings(routeCtx as SandboxedRouteContext<SettingsFormInput>, ctx);
		}
		if (actionId !== undefined && ORDERS_ACTION_IDS.has(actionId)) {
			return orders(routeCtx as SandboxedRouteContext<OrdersPageInput>, ctx);
		}
		if (actionId !== undefined && PRODUCTS_ACTION_IDS.has(actionId)) {
			return products(routeCtx as SandboxedRouteContext<ProductsPageInput>, ctx);
		}
		if (actionId !== undefined && TAX_ACTION_IDS.has(actionId)) {
			return tax(routeCtx as SandboxedRouteContext<TaxPageInput>, ctx);
		}

		// 6. Fallback — em-dash house style for an unrecognized interaction.
		return { blocks: [] };
	};
}
