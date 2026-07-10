/**
 * PDP — a PLUGIN-OWNED PUBLIC ROUTE (Phase 2 §7 step 9, shape per
 * ADR-0003).
 *
 * Step 2.0's platform spike disproved the plan §4.1 fragment assumption:
 * `page:fragments` is trusted-plugin-only (em-dash
 * `packages/core/src/page/fragments.ts:5` — "Sandboxed plugins are never
 * invoked"; the runtime's contribution pass calls sandboxed plugins for
 * `page:metadata` only, whose contribution kinds carry no HTML), and Urumi
 * must stay sandboxed (DEVELOPMENT.md §5). So the PDP is this public route:
 * the theme's thin Astro page at the clean path (`/products/[slug]`) runs
 * the tier-① CMS read, invokes this route with the content (in-process via
 * `locals.emdash.handlePublicPluginApiRoute` — the em-dash forms-plugin
 * pattern), and renders the returned view model + JSON-LD
 * (`<script type="application/ld+json">`). See
 * `adr/0003-storefront-plugin-routes.md` and
 * `storefront/page-fragments-spike.md`.
 *
 * The join itself (§4.2) is unchanged from the plan: CMS content +
 * commerce-service data meet in app code, keyed by `productId = CMS id` —
 * never a cross-database SQL join. Even this single lookup rides the
 * request-scoped batch loader, so the PDP exercises the same one-call path
 * the PLP proves at scale.
 */
import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { HttpCommerceClient } from "../product-commerce/http-commerce-client.js";
import { CommerceBatchLoader } from "../catalog/commerce-batch-loader.js";
import { parseCommerceBatchItem } from "../catalog/commerce-view.js";
import { joinProduct } from "../catalog/join-product.js";
import { buildProductJsonLd } from "../catalog/product-json-ld.js";
import type { PluginContext, RouteHandler } from "../types.js";
import { buildProductViewModel, type ProductViewModel } from "./product-view-model.js";
import { parseCmsProductContent, sanitizeLocale } from "./route-input.js";

/** Public route name — dispatched at
 *  `POST /_emdash/api/plugins/urumi/storefront/product`. */
export const STOREFRONT_PRODUCT_ROUTE = "storefront/product";

export interface PdpRouteInput {
	/** The tier-① CMS product content (validated here — the route is public). */
	content?: unknown;
	/** BCP-47 tag for price formatting; garbage falls back, never fails. */
	locale?: unknown;
}

export type PdpRouteResult =
	| { ok: true; product: ProductViewModel; jsonLd: Record<string, unknown> }
	| { ok: false; error: "INVALID_CONTENT" };

/** One loader per invocation = the plan's request-scoped lifecycle
 *  (§4.3.2): no cross-request cache in v1 (pre-approved decision 3). */
export function createCommerceLoader(ctx: PluginContext): CommerceBatchLoader {
	const client = new HttpCommerceClient({
		fetch: ctx.http.fetch,
		baseUrl: COMMERCE_SERVICE_BASE_URL,
	});
	return new CommerceBatchLoader(async (ids) =>
		(await client.getCommerceBatch(ids)).map(parseCommerceBatchItem),
	);
}

export function createPdpRouteHandler(): RouteHandler<PdpRouteInput> {
	return async (routeCtx, ctx): Promise<PdpRouteResult> => {
		const content = parseCmsProductContent(routeCtx.input.content);
		if (content === null) {
			return { ok: false, error: "INVALID_CONTENT" };
		}
		const locale = sanitizeLocale(routeCtx.input.locale);

		const loader = createCommerceLoader(ctx);
		const commerce = await loader.load(content.id);
		// null covers unsynced / soft-deleted / batch-omitted identically
		// (§4.2): the page renders not-purchasable instead of 500ing.
		const joined = joinProduct(content, commerce);

		return {
			ok: true,
			product: buildProductViewModel(joined, locale),
			jsonLd: buildProductJsonLd(joined),
		};
	};
}
