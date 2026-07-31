import {
	listProductCommerceByIds,
	productId,
	type ProductCommerceStore,
	type ProductCommerceView,
} from "@otta-sh/domain";
import { Hono } from "hono";
import { commerceBatchBody } from "../schemas.js";

export interface CatalogDeps {
	productCommerce: ProductCommerceStore;
}

/**
 * Batch id cap (Phase 2 §6/§8 risk 6, pre-approved): a REQUEST-SIZE guard,
 * not a pagination feature — no cursor semantics are invented beyond the
 * port (ADR-0002 rule 2). Sized ≥ 2× the plugin's PLP page cap (48) so a
 * single page render never needs to split into multiple batch calls.
 */
export const COMMERCE_BATCH_ID_CAP = 100;

/**
 * Catalog read routes — Phase 2 §6/§7 step 3. ONE endpoint,
 * `POST /catalog/commerce/batch`, a 1:1 serialization of
 * `ProductCommerceStore.listCommerceByIds`: known ids come back as items,
 * missing/soft-deleted/commerce-incomplete ids are silently omitted (no
 * per-id error entries, no 404 — "no status-code-as-logic"), `inStock` is
 * computed by the store's single intra-DB join (§6 invariant — never a
 * second inventory round trip), and money on the wire is an integer +
 * ISO-4217 string. 400 only for schema failure / the id cap.
 *
 * Kept in its own file: a parallel Phase-4 branch adds its own routes —
 * `app.ts`/`schemas.ts` edits stay minimal and additive.
 */
export function catalogRoutes(deps: CatalogDeps): Hono {
	const app = new Hono();

	app.post("/commerce/batch", async (c) => {
		const parsed = commerceBatchBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		const views = await listProductCommerceByIds(
			deps.productCommerce,
			parsed.data.productIds.map((id) => productId(id)),
		);
		return c.json({ items: views.map(serializeView) }, 200);
	});

	return app;
}

function serializeView(view: ProductCommerceView): Record<string, unknown> {
	return {
		productId: view.productId,
		sku: view.sku,
		price: { amount: view.price.amount, currency: view.price.currency },
		inStock: view.inStock,
		// The publish gate the plugin's join derives purchasability from
		// (purchasable ⟺ present && active) — false for every row until the
		// deferred afterPublish→activate wiring lands.
		active: view.active,
	};
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}
