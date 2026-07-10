/**
 * PLP — a PLUGIN-OWNED PUBLIC ROUTE (Phase 2 §7 step 10, shape per
 * ADR-0003; see pdp-route.ts for why fragments were unavailable).
 *
 * ONE render path, three entry points (§5): all-products, taxonomy-filtered
 * and search-result listings differ only in WHICH tier-① CMS query produced
 * the page of content — native EmDash taxonomy CRUD / FTS5 `search()`, run
 * by the theme page outside the plugin (ADR-0003), never by the commerce
 * service (it has no text index and is only ever queried for commercial
 * data on a known id set). The already-narrowed page arrives on this
 * route's input with its `query` descriptor echoed back for the theme's
 * heading/canonical needs.
 *
 * The headline N+1 guarantee (§1 case 4): one page render issues exactly
 * ONE commerce-batch HTTP call — the request-scoped loader coalesces the
 * page, the page-size cap keeps every page under the loader's/service's
 * batch cap (48 ≤ ½·100, pre-approved decision 6), and `inStock` arrives ON
 * that one response (§6 invariant: zero inventory-only calls — pinned by
 * the sandbox test's call-count assertions).
 *
 * Non-purchasable items are SHOWN and flagged, never filtered (§4.5 /
 * pre-approved decision 4): content visibility ≠ purchasability.
 */
import { joinProduct } from "../catalog/join-product.js";
import type { CmsProductContent } from "../catalog/join-product.js";
import type { RouteHandler } from "../types.js";
import { createCommerceLoader, renderGuard } from "./pdp-route.js";
import { buildProductViewModel, type ProductViewModel } from "./product-view-model.js";
import { parseCmsProductContent, sanitizeLocale } from "./route-input.js";

/** Public route name — dispatched at
 *  `POST /_emdash/api/plugins/urumi/storefront/list`. */
export const STOREFRONT_LIST_ROUTE = "storefront/list";

/**
 * PLP page-size cap (plan §4.3.3/§8 risk 6, pre-approved: 24–50): keeps the
 * batch request/response bodies small and — at ≤ half the service's
 * 100-id cap — guarantees a single page NEVER splits into two batch calls.
 */
export const PLP_PAGE_SIZE_CAP = 48;

/** Which tier-① CMS query produced this page — echo metadata, one render path. */
export type PlpQuery =
	| { kind: "all" }
	| { kind: "taxonomy"; taxonomy: string; term: string }
	| { kind: "search"; query: string };

export interface PlpRouteInput {
	/** The tier-①-queried page of CMS product content (validated here). */
	items?: unknown;
	locale?: unknown;
	query?: unknown;
}

export type PlpRouteResult =
	| { ok: true; items: ProductViewModel[]; query: PlpQuery }
	| { ok: false; error: "INVALID_ITEMS" }
	| { ok: false; error: "PAGE_TOO_LARGE"; max: number }
	| { ok: false; error: "RENDER_FAILED" };

export function createPlpRouteHandler(): RouteHandler<PlpRouteInput> {
	// Caveat (public route, reachable directly): caller-supplied `items` are
	// NOT independently verified against the CMS — see pdp-route.ts; the
	// joined commercial data is public-by-design, so nothing privileged is
	// reachable through fabricated content.
	//
	// JSON-LD is deliberately PDP-only in this phase (plan §1 case 3 emits
	// Product/Offer on the product page); the PLP view model carries no
	// graph — a listing-level ItemList would be additive later.
	return (routeCtx, ctx): Promise<PlpRouteResult> =>
		renderGuard(STOREFRONT_LIST_ROUTE, async () => {
			const rawItems = routeCtx.input.items;
			if (!Array.isArray(rawItems)) {
				return { ok: false, error: "INVALID_ITEMS" } as const;
			}
			if (rawItems.length > PLP_PAGE_SIZE_CAP) {
				// Rejected BEFORE any commerce call — the cap is what keeps
				// "one page ⇒ one batch call" true by construction.
				return { ok: false, error: "PAGE_TOO_LARGE", max: PLP_PAGE_SIZE_CAP } as const;
			}
			const contents: CmsProductContent[] = [];
			for (const raw of rawItems) {
				const content = parseCmsProductContent(raw);
				if (content === null) {
					return { ok: false, error: "INVALID_ITEMS" } as const;
				}
				contents.push(content);
			}
			const locale = sanitizeLocale(routeCtx.input.locale);
			const query = parsePlpQuery(routeCtx.input.query);

			// Collect every CMS id on the page, then ONE batched call (§4.3.1);
			// the loader dedupes duplicates within the page.
			const loader = createCommerceLoader(ctx);
			const commerceById = await loader.loadMany(contents.map((content) => content.id));

			const items = contents.map((content) =>
				buildProductViewModel(joinProduct(content, commerceById.get(content.id) ?? null), locale),
			);
			return { ok: true as const, items, query };
		});
}

/** Malformed query metadata degrades to "all" — it only labels which CMS
 *  query produced the page; it never re-runs or alters the query. */
function parsePlpQuery(value: unknown): PlpQuery {
	if (typeof value !== "object" || value === null) return { kind: "all" };
	const v = value as Record<string, unknown>;
	if (
		v["kind"] === "taxonomy" &&
		typeof v["taxonomy"] === "string" &&
		v["taxonomy"].length > 0 &&
		typeof v["term"] === "string" &&
		v["term"].length > 0
	) {
		return { kind: "taxonomy", taxonomy: v["taxonomy"], term: v["term"] };
	}
	if (v["kind"] === "search" && typeof v["query"] === "string" && v["query"].length > 0) {
		return { kind: "search", query: v["query"] };
	}
	return { kind: "all" };
}
