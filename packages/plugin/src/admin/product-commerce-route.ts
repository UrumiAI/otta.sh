import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { HttpCommerceClient } from "../product-commerce/http-commerce-client.js";
import type { UpsertProductCommerceInput } from "../product-commerce/commerce-client.js";
import type { RouteHandler } from "../types.js";

/** The non-public route path the panel's Save action posts to (plan §5). */
export const PRODUCT_COMMERCE_ROUTE = "product-commerce";

/**
 * The posted payload — a Block Kit `form_submit` carries the ENTIRE
 * captured form state keyed by `action_id` (plan §8 Risk 5, confirmed
 * against em-dash: `FormSubmit.values: Record<string, unknown>`), so no
 * `content:read` re-read is needed — the panel's own field values are
 * enough. `productId` is threaded in by the host from the current document
 * (or by the panel's own button `value`, em-dash `ButtonElement.value`).
 */
export interface ProductCommerceRouteInput {
	productId?: unknown;
	sku?: unknown;
	price?: unknown;
	currency?: unknown;
	onHand?: unknown;
	productKind?: unknown;
	taxClass?: unknown;
	weightGrams?: unknown;
	lengthMm?: unknown;
	widthMm?: unknown;
	heightMm?: unknown;
}

export type ProductCommerceRouteResult =
	| { ok: true; productCommerce: unknown }
	| { ok: false; error: "MISSING_PRODUCT_ID" };

/**
 * Validates and calls `CommerceClient.upsert` (plan §5). "Create then
 * price", API/domain layer (plan §1 case 3): a missing/empty `productId` is
 * rejected here BEFORE any commercial write is attempted — the
 * server-side counterpart to the widget's disabled UX (which never offers
 * this action for an unsaved product in the first place), so a
 * hand-crafted request can't bypass the UX.
 */
export function createProductCommerceRouteHandler(): RouteHandler<ProductCommerceRouteInput> {
	return async (routeCtx, ctx): Promise<ProductCommerceRouteResult> => {
		const input = routeCtx.input;
		const productId = input.productId;
		if (typeof productId !== "string" || productId.length === 0) {
			return { ok: false, error: "MISSING_PRODUCT_ID" };
		}

		const body: UpsertProductCommerceInput = {};
		if (typeof input.sku === "string" && input.sku.length > 0) body.sku = input.sku;
		if (typeof input.price === "number" && typeof input.currency === "string") {
			body.price = { amount: input.price, currency: input.currency };
		}
		if (typeof input.taxClass === "string") body.taxClass = input.taxClass;
		if (typeof input.weightGrams === "number") body.weightGrams = input.weightGrams;
		if (typeof input.lengthMm === "number") body.lengthMm = input.lengthMm;
		if (typeof input.widthMm === "number") body.widthMm = input.widthMm;
		if (typeof input.heightMm === "number") body.heightMm = input.heightMm;
		if (input.productKind === "physical" || input.productKind === "digital") {
			body.productKind = input.productKind;
		}
		if (typeof input.onHand === "number") body.initialOnHand = input.onHand;

		const client = new HttpCommerceClient({
			fetch: ctx.http.fetch,
			baseUrl: COMMERCE_SERVICE_BASE_URL,
		});
		// A fresh key per explicit Save click — each click is a genuinely new
		// merchant-intended write, unlike the content-revision-derived sync key
		// (sync/derive-idempotency-key.ts) which dedupes hook replays of the
		// SAME save.
		const key = `${productId}:panel:${Date.now()}:${Math.random().toString(36).slice(2)}`;
		const row = await client.upsertProductCommerce(productId, body, key);
		return { ok: true, productCommerce: row };
	};
}
