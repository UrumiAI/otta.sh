import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { HttpCommerceClient } from "../product-commerce/http-commerce-client.js";
import type { RouteHandler } from "../types.js";

/** The PUBLIC route path a digital-download link posts to (plan §6). */
export const ENTITLEMENT_DOWNLOAD_ROUTE = "entitlements/download";

export interface EntitlementDownloadInput {
	orderId?: unknown;
	buyerRef?: unknown;
	sku?: unknown;
}

export type EntitlementDownloadResult =
	| { authorized: true; sku: string }
	| { authorized: false; reason: "NOT_ENTITLED" | "INVALID_INPUT" };

/**
 * Entitlement-gated digital download (plan §6, step 4.9). The plugin route calls
 * the service's entitlement **check** via `ctx.http` and authorizes delivery only
 * when an active entitlement exists — the file is never served without one.
 *
 * SEAM NOTE: the actual file bytes / signed-R2-URL are served by the storefront
 * layer (Phase-2 scaffolding, not yet merged). This route returns the
 * authorization decision; wiring it to the object store is a storefront concern.
 * The plugin holds no secret and its only egress is `ctx.http` + `allowedHosts`.
 */
export function createEntitlementDownloadHandler(): RouteHandler<EntitlementDownloadInput> {
	return async (routeCtx, ctx): Promise<EntitlementDownloadResult> => {
		const { orderId, buyerRef, sku } = routeCtx.input;
		if (typeof sku !== "string" || sku.length === 0) {
			return { authorized: false, reason: "INVALID_INPUT" };
		}
		const scope: { orderId?: string; buyerRef?: string } = {};
		if (typeof orderId === "string" && orderId.length > 0) scope.orderId = orderId;
		if (typeof buyerRef === "string" && buyerRef.length > 0) scope.buyerRef = buyerRef;
		if (scope.orderId === undefined && scope.buyerRef === undefined) {
			return { authorized: false, reason: "INVALID_INPUT" };
		}

		const client = new HttpCommerceClient({
			fetch: ctx.http.fetch,
			baseUrl: COMMERCE_SERVICE_BASE_URL,
		});
		const entitled = await client.checkEntitlement(scope, sku);
		return entitled ? { authorized: true, sku } : { authorized: false, reason: "NOT_ENTITLED" };
	};
}
