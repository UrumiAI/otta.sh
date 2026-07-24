import { COMMERCE_SERVICE_BASE_URL, serviceTokenFromKv } from "../manifest.js";
import { HttpCommerceClient } from "../product-commerce/http-commerce-client.js";
import type { RouteHandler } from "../types.js";
import { buildProductDataElements } from "./product-data-widget.js";

/**
 * Diagnostic read for the "Product data" widget (issue #81 rework).
 *
 * em-dash renders a sandboxed field widget from the manifest's STATIC
 * `elements` and fills their values from the stored `commerce` field JSON —
 * it does NOT round-trip through a plugin route (field widgets are
 * `onChange`-only; see `product-data-widget.ts`). So this route is no longer on
 * the widget's render path; it is a small admin/introspection endpoint that
 * returns the widget's element shape alongside the currently-derived
 * `product_commerce` row for a product, over `ctx.http`.
 */
export const PANEL_STATE_ROUTE = "product-data/panel-state";

export interface PanelStateRouteInput {
	productId?: unknown;
}

export function createPanelStateRouteHandler(): RouteHandler<PanelStateRouteInput> {
	return async (routeCtx, ctx) => {
		const elements = buildProductDataElements();
		const productId = routeCtx.input.productId;
		if (typeof productId !== "string" || productId.length === 0) {
			return { elements, commerce: null };
		}
		// `getProductCommerce` is a GET (write-gate-exempt); the token is threaded
		// for uniformity (ADR-0007) — undefined ⇒ no header ⇒ unchanged wire.
		const serviceToken = await serviceTokenFromKv(ctx);
		const client = new HttpCommerceClient({
			fetch: ctx.http.fetch,
			baseUrl: COMMERCE_SERVICE_BASE_URL,
			...(serviceToken !== undefined ? { serviceToken } : {}),
		});
		const commerce = await client.getProductCommerce(productId);
		return { elements, commerce };
	};
}
