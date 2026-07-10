import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { HttpCommerceClient } from "../product-commerce/http-commerce-client.js";
import type { RouteHandler } from "../types.js";
import { buildProductDataElements } from "./product-data-widget.js";

/** Serves the LIVE, state-aware Block Kit tree for the "Product data" panel
 *  (plan §8 Risk 5) — the manifest's static `FieldWidgetConfig.elements` is
 *  only the default/disabled shape; the host re-renders from this route's
 *  result once a `productId` exists. */
export const PANEL_STATE_ROUTE = "product-data/panel-state";

export interface PanelStateRouteInput {
	productId?: unknown;
}

export function createPanelStateRouteHandler(): RouteHandler<PanelStateRouteInput> {
	return async (routeCtx, ctx) => {
		const productId = routeCtx.input.productId;
		if (typeof productId !== "string" || productId.length === 0) {
			return { elements: buildProductDataElements({ hasProductId: false }) };
		}
		const client = new HttpCommerceClient({
			fetch: ctx.http.fetch,
			baseUrl: COMMERCE_SERVICE_BASE_URL,
		});
		const commerce = await client.getProductCommerce(productId);
		return { elements: buildProductDataElements({ hasProductId: true, commerce }) };
	};
}
