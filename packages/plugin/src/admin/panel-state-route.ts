import { COMMERCE_SERVICE_BASE_URL, serviceTokenFromKv } from "../manifest.js";
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
	/** Whether the current CMS document is PUBLISHED (issue #82) — host-threaded
	 *  from the document alongside `productId`. Baked into the Save button's
	 *  `value` so the panel Save can activate the just-priced row without a
	 *  republish. Absent ⇒ no publish signal is carried. */
	published?: unknown;
	/** The current document's `updatedAt` ordering watermark, paired with
	 *  `published` (issue #82). */
	contentUpdatedAt?: unknown;
}

export function createPanelStateRouteHandler(): RouteHandler<PanelStateRouteInput> {
	return async (routeCtx, ctx) => {
		const productId = routeCtx.input.productId;
		if (typeof productId !== "string" || productId.length === 0) {
			return { elements: buildProductDataElements({ hasProductId: false }) };
		}
		// `getProductCommerce` is a GET (gate-exempt); the token is threaded for
		// uniformity (ADR-0007) — undefined ⇒ no header ⇒ unchanged wire.
		const serviceToken = await serviceTokenFromKv(ctx);
		const client = new HttpCommerceClient({
			fetch: ctx.http.fetch,
			baseUrl: COMMERCE_SERVICE_BASE_URL,
			...(serviceToken !== undefined ? { serviceToken } : {}),
		});
		const commerce = await client.getProductCommerce(productId);
		// Issue #82: thread the document's publish state into the Save button so a
		// "publish first, price later" product activates on save. Only forwarded
		// when the host actually threaded a boolean signal — otherwise omitted so
		// the button carries none and the route leaves the row inactive.
		const { published, contentUpdatedAt } = routeCtx.input;
		return {
			elements: buildProductDataElements({
				hasProductId: true,
				commerce,
				...(typeof published === "boolean" ? { published } : {}),
				...(typeof contentUpdatedAt === "string" ? { contentUpdatedAt } : {}),
			}),
		};
	};
}
