/**
 * PDP — a PLUGIN-OWNED PUBLIC ROUTE (Phase 2 §7 step 9, shape per
 * ADR-0003).
 *
 * Step 2.0's platform spike disproved the plan §4.1 fragment assumption:
 * `page:fragments` is trusted-plugin-only (em-dash
 * `packages/core/src/page/fragments.ts:5` — "Sandboxed plugins are never
 * invoked"; the runtime's contribution pass calls sandboxed plugins for
 * `page:metadata` only, whose contribution kinds carry no HTML), and Otta
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
import { COMMERCE_SERVICE_BASE_URL, serviceTokenFromKv } from "../manifest.js";
import { HttpCommerceClient } from "../product-commerce/http-commerce-client.js";
import { CommerceBatchLoader } from "../catalog/commerce-batch-loader.js";
import { parseCommerceBatchItem } from "../catalog/commerce-view.js";
import { joinProduct } from "../catalog/join-product.js";
import { buildProductJsonLd } from "../catalog/product-json-ld.js";
import type { PluginContext, RouteHandler } from "../types.js";
import { buildProductViewModel, type ProductViewModel } from "./product-view-model.js";
import { parseCmsProductContent, sanitizeLocale } from "./route-input.js";

/** Public route name — dispatched at
 *  `POST /_emdash/api/plugins/otta/storefront/product`. */
export const STOREFRONT_PRODUCT_ROUTE = "storefront/product";

export interface PdpRouteInput {
	/** The tier-① CMS product content (validated here — the route is public). */
	content?: unknown;
	/** BCP-47 tag for price formatting; garbage falls back, never fails. */
	locale?: unknown;
}

export type PdpRouteResult =
	| { ok: true; product: ProductViewModel; jsonLd: Record<string, unknown> }
	| { ok: false; error: "INVALID_CONTENT" }
	| { ok: false; error: "RENDER_FAILED" };

/**
 * Unexpected-failure guard for the PUBLIC storefront handlers: an uncaught
 * throw would surface through em-dash's route envelope as
 * `ROUTE_ERROR: <error.message>` (`handleSandboxedRoute`,
 * `emdash-runtime.ts:3563-3571`) — leaking internals (e.g. a `cents()`
 * RangeError describing a malformed upstream amount) to anonymous callers.
 * Expected rejections keep their structured shapes; anything else is logged
 * server-side and collapsed to a message-free `RENDER_FAILED`.
 */
export async function renderGuard<T>(
	route: string,
	render: () => Promise<T>,
): Promise<T | { ok: false; error: "RENDER_FAILED" }> {
	try {
		return await render();
	} catch (err) {
		console.error(`[otta] ${route} render failed:`, err);
		return { ok: false, error: "RENDER_FAILED" };
	}
}

/** One loader per invocation = the plan's request-scoped lifecycle
 *  (§4.3.2): no cross-request cache in v1 (pre-approved decision 3). Async
 *  because it awaits the write-gate token from write-only kv (ADR-0007):
 *  `getCommerceBatch` is a POST *read* the service gate blocks without
 *  `X-Service-Token` — so PDP/PLP genuinely depend on kv provisioning when the
 *  service secret is set. Undefined ⇒ no header ⇒ pre-gate wire. */
export async function createCommerceLoader(ctx: PluginContext): Promise<CommerceBatchLoader> {
	const serviceToken = await serviceTokenFromKv(ctx);
	const client = new HttpCommerceClient({
		fetch: ctx.http.fetch,
		baseUrl: COMMERCE_SERVICE_BASE_URL,
		...(serviceToken !== undefined ? { serviceToken } : {}),
	});
	return new CommerceBatchLoader(async (ids) =>
		(await client.getCommerceBatch(ids)).map(parseCommerceBatchItem),
	);
}

export function createPdpRouteHandler(): RouteHandler<PdpRouteInput> {
	// Caveat (public route, reachable directly): the caller-supplied
	// `content` is NOT independently verified against the CMS — the route
	// joins whatever content it is handed with public-by-design commercial
	// data, so a fabricated call yields at worst a view model for invented
	// content; no privileged data path exists here.
	return (routeCtx, ctx): Promise<PdpRouteResult> =>
		renderGuard(STOREFRONT_PRODUCT_ROUTE, async () => {
			const content = parseCmsProductContent(routeCtx.input.content);
			if (content === null) {
				return { ok: false, error: "INVALID_CONTENT" } as const;
			}
			const locale = sanitizeLocale(routeCtx.input.locale);

			const loader = await createCommerceLoader(ctx);
			const commerce = await loader.load(content.id);
			// null covers unsynced / soft-deleted / batch-omitted identically
			// (§4.2): the page renders not-purchasable instead of 500ing.
			const joined = joinProduct(content, commerce);

			return {
				ok: true as const,
				product: buildProductViewModel(joined, locale),
				jsonLd: buildProductJsonLd(joined),
			};
		});
}
