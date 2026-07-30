import {
	activateProductCommerce,
	cents,
	currency,
	deactivateProductCommerce,
	getProductCommerce,
	idempotencyKey,
	MissingProductIdError,
	money,
	productId,
	softDeleteProductCommerce,
	sku,
	SkuConflictError,
	upsertProductCommerce,
	type ProductCommerce,
	type ProductCommerceDeps,
} from "@otta-sh/domain";
import { Hono } from "hono";
import { lifecycleProductCommerceBody, upsertProductCommerceBody } from "../schemas.js";

// The domain use-case's own deps type is the single source of truth (N3);
// re-exported so existing importers keep working.
export type { ProductCommerceDeps };

/**
 * Product-commerce routes — 1:1 with the port (Phase 1 §7): `PUT`/`GET`/
 * `DELETE /products/:id/commerce`. No status-code-as-logic beyond schema/
 * validation failures and `MISSING_PRODUCT_ID` (the one domain rejection
 * this port has); money on the wire is an integer + ISO-4217 string.
 */
export function productCommerceRoutes(deps: ProductCommerceDeps): Hono {
	const app = new Hono();

	app.put("/:id/commerce", async (c) => {
		const id = c.req.param("id");
		const key = c.req.header("Idempotency-Key");
		if (key === undefined || key.length === 0) {
			return c.json({ error: "missing Idempotency-Key header" }, 400);
		}
		if (id.length === 0) {
			return c.json({ error: "MISSING_PRODUCT_ID" }, 400);
		}
		const parsed = upsertProductCommerceBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		const body = parsed.data;

		try {
			const row = await upsertProductCommerce(
				{ productCommerce: deps.productCommerce, inventory: deps.inventory },
				{
					productId: productId(id),
					sku: body.sku !== undefined ? sku(body.sku) : undefined,
					price:
						body.price !== undefined
							? money(cents(body.price.amount), currency(body.price.currency))
							: undefined,
					title: body.title,
					taxClass: body.taxClass,
					weightGrams: body.weightGrams,
					lengthMm: body.lengthMm,
					widthMm: body.widthMm,
					heightMm: body.heightMm,
					productKind: body.productKind,
					contentUpdatedAt: body.contentUpdatedAt,
				},
				idempotencyKey(key),
				body.initialOnHand,
			);
			return c.json(serialize(row), 200);
		} catch (err) {
			if (err instanceof MissingProductIdError) {
				return c.json({ error: "MISSING_PRODUCT_ID" }, 400);
			}
			// Review F2: a live-SKU conflict is a structured 409, not an opaque
			// 500 — the most likely real merchant input error deserves a shape
			// the panel can render.
			if (err instanceof SkuConflictError) {
				return c.json({ ok: false, error: "SKU_TAKEN", sku: err.sku }, 409);
			}
			throw err;
		}
	});

	app.get("/:id/commerce", async (c) => {
		const id = c.req.param("id");
		if (id.length === 0) {
			return c.json({ error: "MISSING_PRODUCT_ID" }, 400);
		}
		const row = await getProductCommerce(deps.productCommerce, productId(id));
		return c.json(row === null ? null : serialize(row), 200);
	});

	app.delete("/:id/commerce", async (c) => {
		const id = c.req.param("id");
		const key = c.req.header("Idempotency-Key");
		if (key === undefined || key.length === 0) {
			return c.json({ error: "missing Idempotency-Key header" }, 400);
		}
		if (id.length === 0) {
			return c.json({ error: "MISSING_PRODUCT_ID" }, 400);
		}
		await softDeleteProductCommerce(deps.productCommerce, productId(id), idempotencyKey(key));
		return c.json({ ok: true }, 200);
	});

	// The afterPublish→activate follow-up (Phase 1 §4/§6 step 7): a dedicated
	// action route, not an extra PUT field — `upsert` deliberately never
	// touches `active`/`deletedAt` (see the port doc / `UpsertProductCommerceInput`),
	// so reactivation gets its own narrowly-scoped surface, mirroring the
	// `/inventory/reserve|commit|release` action-route convention. The body
	// carries only the ORDERING WATERMARK (`contentUpdatedAt`) the store gates
	// on so a stale, out-of-order publish is a no-op (out-of-order delivery
	// converges).
	app.post("/:id/commerce/activate", async (c) => {
		const id = c.req.param("id");
		const key = c.req.header("Idempotency-Key");
		if (key === undefined || key.length === 0) {
			return c.json({ error: "missing Idempotency-Key header" }, 400);
		}
		if (id.length === 0) {
			return c.json({ error: "MISSING_PRODUCT_ID" }, 400);
		}
		const parsed = lifecycleProductCommerceBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		await activateProductCommerce(
			deps.productCommerce,
			productId(id),
			idempotencyKey(key),
			parsed.data.contentUpdatedAt,
		);
		return c.json({ ok: true }, 200);
	});

	// The afterUnpublish→deactivate follow-up (Phase 1 §4/§6 step 7): the
	// mirror of the activate route, closing the publish gate. A dedicated
	// action route (not an extra PUT field) for the same reason activate is —
	// `upsert` never touches `active`/`deletedAt`. The body carries only the
	// ordering watermark (`contentUpdatedAt`) — see the activate route.
	app.post("/:id/commerce/deactivate", async (c) => {
		const id = c.req.param("id");
		const key = c.req.header("Idempotency-Key");
		if (key === undefined || key.length === 0) {
			return c.json({ error: "missing Idempotency-Key header" }, 400);
		}
		if (id.length === 0) {
			return c.json({ error: "MISSING_PRODUCT_ID" }, 400);
		}
		const parsed = lifecycleProductCommerceBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		await deactivateProductCommerce(
			deps.productCommerce,
			productId(id),
			idempotencyKey(key),
			parsed.data.contentUpdatedAt,
		);
		return c.json({ ok: true }, 200);
	});

	return app;
}

function serialize(row: ProductCommerce): Record<string, unknown> {
	return {
		productId: row.productId,
		sku: row.sku,
		price: row.price === null ? null : { amount: row.price.amount, currency: row.price.currency },
		title: row.title,
		taxClass: row.taxClass,
		// Increment 2 slice 5: compare-at (display data) + inventory policy round-
		// trip on this raw commerce read. `unitCost` is DELIBERATELY OMITTED — this
		// GET is NOT behind the internal token (the write gate only covers non-GET
		// verbs), so it is a storefront-reachable read path, and unit cost is
		// admin-only margin data that must never leak to a buyer. Cost is served
		// ONLY by the internal-token admin product detail. Pinned by a test.
		compareAt:
			row.compareAtPrice === null
				? null
				: { amount: row.compareAtPrice.amount, currency: row.compareAtPrice.currency },
		inventoryPolicy: row.inventoryPolicy,
		weightGrams: row.weightGrams,
		lengthMm: row.lengthMm,
		widthMm: row.widthMm,
		heightMm: row.heightMm,
		productKind: row.productKind,
		active: row.active,
		deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
		contentUpdatedAt: row.contentUpdatedAt,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}
