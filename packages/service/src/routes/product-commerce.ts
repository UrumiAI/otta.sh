import {
	activateProductCommerce,
	cents,
	currency,
	deactivateProductCommerce,
	deactivateProductVariant,
	getProductCommerce,
	idempotencyKey,
	InvalidProductFieldError,
	listProductVariants,
	MissingProductIdError,
	MissingVariantKeyError,
	money,
	productId,
	softDeleteProductCommerce,
	sku,
	SkuConflictError,
	SkuHeldStockError,
	SkuStockConflictError,
	updateProductVariantFields,
	upsertProductCommerce,
	upsertProductVariant,
	type ProductCommerce,
	type ProductCommerceDeps,
	type ProductVariant,
	type ProductVariantSummary,
} from "@otta-sh/domain";
import { type Context, Hono } from "hono";
import {
	deactivateProductVariantBody,
	editProductVariantBody,
	lifecycleProductCommerceBody,
	upsertProductCommerceBody,
	upsertProductVariantBody,
} from "../schemas.js";

// The domain use-case's own deps type is the single source of truth (N3);
// re-exported so existing importers keep working.
export type { ProductCommerceDeps };

/**
 * Product-commerce routes — 1:1 with the port (Phase 1 §7): `PUT`/`GET`/
 * `DELETE /products/:id/commerce`, the two publish-gate actions, and the
 * variant surface (`GET /products/:id/variants` plus one route per variant
 * WRITER — see the block above them). No status-code-as-logic beyond schema/
 * validation failures and the domain's own rejections, each a structured body
 * carrying a machine code — `MISSING_PRODUCT_ID`, `MISSING_VARIANT_KEY`, the
 * three sku refusals (`SKU_TAKEN`, `SKU_STOCK_CONFLICT`, `SKU_HELD_STOCK`) and
 * the variant edit's compare-and-set outcomes (`VARIANT_NOT_FOUND`,
 * `STALE_EDIT`, `CURRENCY_MISMATCH`); money on the wire is an integer +
 * ISO-4217 string, and an absent price is `null` rather than zero.
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
			// A SKU RENAME the domain refuses, in the same shape: a machine code plus
			// the operands the caller has to act on — both skus, or the sku and how
			// many live holds still name it. Never the 500 an unmapped throw would be,
			// and never the domain's internal sentence.
			if (err instanceof SkuStockConflictError) {
				return c.json(
					{ ok: false, error: "SKU_STOCK_CONFLICT", fromSku: err.fromSku, toSku: err.toSku },
					409,
				);
			}
			if (err instanceof SkuHeldStockError) {
				return c.json(
					{ ok: false, error: "SKU_HELD_STOCK", sku: err.sku, liveHolds: err.liveHolds },
					409,
				);
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

	// -- Variants: one route per WRITER (ADR-0016) ---------------------------
	//
	// Four routes, and the shape of them is the decision: the CMS sync declares
	// a variant's presence and name through `PUT`, the admin prices it through
	// `PATCH`, the sync drops it through the `/deactivate` action, and everyone
	// reads it through `GET`. `PUT` and `PATCH` are not two spellings of one
	// upsert — they are the two writers ADR-0016 keeps apart, and their bodies
	// (`upsertProductVariantBody` / `editProductVariantBody`, both `.strict()`)
	// each REJECT the other's fields rather than dropping them, so crossing the
	// line is a 400 an integrator can read and not a silent 200.
	//
	// The variant key travels in the PATH because it IS the identity: it is
	// immutable, it is half the primary key, and there is no field on either
	// body that could change it. `MISSING_VARIANT_KEY` mirrors the
	// `MISSING_PRODUCT_ID` guard above — routing already forbids an empty
	// segment, so the route-level check covers the whitespace-only case and the
	// `catch` covers whatever an adapter decides is empty.
	//
	// THE WRITE REPLIES ARE NOT LIST ROWS, and the asymmetry is a decision. `PUT`
	// and `PATCH` answer the row they just wrote, WITHOUT `inStock`: a write reply
	// states what the write did, and the store returns the stored row — no stock
	// is joined for it, so an `inStock` here could only be invented. Emitting a
	// hardcoded `false` beside a size that has units would be worse than omitting
	// it, and re-reading inventory to fill the field would put a second query on
	// every write to serve a value the caller did not ask for. A caller that wants
	// the stock signal reads the list, which joins it in the same statement.

	/**
	 * The variants read. LIVE ROWS ONLY: an orphan is filtered out here, and the
	 * filter is the decision — this GET is unauthenticated (the write gate covers
	 * non-GET verbs only), and the caller it exists for is the storefront picker,
	 * which needs the sizes a shopper may buy and nothing else.
	 *
	 * An orphan is a size the merchant has DISCONTINUED. Publishing it here would
	 * put its title and its last price on an anonymous read — the shape of the
	 * catalogue somebody stopped selling, and what they used to charge for it —
	 * to serve a picker that must not render it anyway. Same rule as the omitted
	 * unit cost on the commerce read beside this one: the ungated read carries
	 * what a buyer may act on, and nothing else.
	 *
	 * Surfacing orphans is exactly what the console needs (a tombstone may still
	 * hold stock and sit on live orders, and hiding it is how units get stranded),
	 * so the orphan projection is owed to the INTERNAL-TOKEN admin surface, where
	 * unit cost and the exact on-hand count already live. The port keeps returning
	 * orphans flagged; this route is the boundary that decides who sees them.
	 */
	app.get("/:id/variants", async (c) => {
		const id = c.req.param("id");
		if (id.length === 0) {
			return c.json({ error: "MISSING_PRODUCT_ID" }, 400);
		}
		const rows = await listProductVariants(deps.productCommerce, productId(id));
		// An unknown product, one that has declared no variants, and one whose
		// every size is orphaned are all `[]` — absence, never a 404. The first of
		// those is the state the entire live catalog is in.
		return c.json(
			{ variants: rows.filter((row) => row.orphanedAt === null).map(serializeVariantSummary) },
			200,
		);
	});

	// The CMS-SYNC channel. Writes presence + the display-name cache and NOTHING
	// commercial; it never refuses presence and never raises a sku conflict (the
	// commerce database does not get a vote on whether a size exists), so the
	// only refusals here are the two identity ones.
	app.put("/:id/variants/:variantKey", async (c) => {
		const id = c.req.param("id");
		const variantKey = c.req.param("variantKey");
		const key = c.req.header("Idempotency-Key");
		if (key === undefined || key.length === 0) {
			return c.json({ error: "missing Idempotency-Key header" }, 400);
		}
		if (id.length === 0) {
			return c.json({ error: "MISSING_PRODUCT_ID" }, 400);
		}
		if (variantKey.trim().length === 0) {
			return c.json({ error: "MISSING_VARIANT_KEY" }, 400);
		}
		const parsed = upsertProductVariantBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		const body = parsed.data;
		try {
			const row = await upsertProductVariant(
				deps.productCommerce,
				{
					productId: productId(id),
					variantKey,
					...(body.title !== undefined ? { title: body.title } : {}),
					...(body.contentUpdatedAt !== undefined
						? { contentUpdatedAt: body.contentUpdatedAt }
						: {}),
				},
				idempotencyKey(key),
			);
			return c.json(serializeVariant(row), 200);
		} catch (err) {
			return variantIdentityFailure(c, err);
		}
	});

	// The guarded ADMIN edit: sku + price under a compare-and-set. Every typed
	// outcome the port defines gets the envelope its neighbours already use —
	// the three sku refusals in the same `{ ok: false, error, …operands }` 409
	// the upsert above answers with, and the three non-`ok` results mapped the
	// way the admin console's own product edit maps them (404 not-found, 409
	// stale carrying the fresh watermark, 409 currency carrying the currency the
	// row is anchored to). Nothing here is a 500.
	app.patch("/:id/variants/:variantKey", async (c) => {
		const id = c.req.param("id");
		const variantKey = c.req.param("variantKey");
		const key = c.req.header("Idempotency-Key");
		if (key === undefined || key.length === 0) {
			return c.json({ error: "missing Idempotency-Key header" }, 400);
		}
		if (id.length === 0) {
			return c.json({ error: "MISSING_PRODUCT_ID" }, 400);
		}
		if (variantKey.trim().length === 0) {
			return c.json({ error: "MISSING_VARIANT_KEY" }, 400);
		}
		const parsed = editProductVariantBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		const body = parsed.data;
		try {
			const res = await updateProductVariantFields(
				{ productCommerce: deps.productCommerce, inventory: deps.inventory },
				{
					productId: productId(id),
					variantKey,
					...(body.sku !== undefined ? { sku: sku(body.sku) } : {}),
					...(body.price !== undefined
						? { price: money(cents(body.price.amount), currency(body.price.currency)) }
						: {}),
					// No `title`: CMS-owned, and the body `.strict()`-rejects one.
				},
				idempotencyKey(key),
				body.expectedUpdatedAt,
			);
			if (res.ok) return c.json(serializeVariant(res.variant), 200);
			if (res.reason === "not_found") {
				// Unknown key OR an orphaned row: an edit is neither a create nor a
				// resurrection — the way back is the CMS re-declaring the key.
				return c.json({ ok: false, error: "VARIANT_NOT_FOUND" }, 404);
			}
			if (res.reason === "stale") {
				return c.json(
					{
						ok: false,
						error: "STALE_EDIT",
						currentUpdatedAt: res.current.updatedAt.toISOString(),
					},
					409,
				);
			}
			// currency_mismatch. `currency` is THE VARIANT'S OWN stored currency and
			// only that — it is read off the row the store handed back, so it is
			// `null` in the archetypal case, a FIRST pricing refused because it
			// disagreed with the PRODUCT's currency rather than with anything this
			// row holds. That is not a gap to paper over with the product's
			// currency: the field states what this row is anchored to, `null` means
			// "nothing yet", and a console renders the conflict from the product it
			// already has on screen. Absent is null, never a coerced string, and
			// never the other row's value smuggled in under this name.
			return c.json(
				{ ok: false, error: "CURRENCY_MISMATCH", currency: res.current.price?.currency ?? null },
				409,
			);
		} catch (err) {
			if (err instanceof InvalidProductFieldError) {
				return c.json({ ok: false, error: "INVALID_FIELD", field: err.field }, 400);
			}
			if (err instanceof SkuConflictError) {
				return c.json({ ok: false, error: "SKU_TAKEN", sku: err.sku }, 409);
			}
			if (err instanceof SkuStockConflictError) {
				return c.json(
					{ ok: false, error: "SKU_STOCK_CONFLICT", fromSku: err.fromSku, toSku: err.toSku },
					409,
				);
			}
			if (err instanceof SkuHeldStockError) {
				return c.json(
					{ ok: false, error: "SKU_HELD_STOCK", sku: err.sku, liveHolds: err.liveHolds },
					409,
				);
			}
			return variantIdentityFailure(c, err);
		}
	});

	// The ORPHAN transition — deactivation, NEVER deletion: the row keeps its
	// sku, its price and its inventory, because an orphan may still hold stock
	// and still sit on live order lines. An unknown key is a no-op, not a 404
	// (no row is minted either way), so this answers `{ ok: true }` uniformly,
	// exactly like the product-level deactivate above.
	app.post("/:id/variants/:variantKey/deactivate", async (c) => {
		const id = c.req.param("id");
		const variantKey = c.req.param("variantKey");
		const key = c.req.header("Idempotency-Key");
		if (key === undefined || key.length === 0) {
			return c.json({ error: "missing Idempotency-Key header" }, 400);
		}
		if (id.length === 0) {
			return c.json({ error: "MISSING_PRODUCT_ID" }, 400);
		}
		if (variantKey.trim().length === 0) {
			return c.json({ error: "MISSING_VARIANT_KEY" }, 400);
		}
		const parsed = deactivateProductVariantBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		try {
			await deactivateProductVariant(
				deps.productCommerce,
				productId(id),
				variantKey,
				idempotencyKey(key),
				parsed.data.contentUpdatedAt,
			);
		} catch (err) {
			return variantIdentityFailure(c, err);
		}
		return c.json({ ok: true }, 200);
	});

	return app;
}

/** The two identity refusals every variant writer shares, mapped to the 400
 *  `MissingProductIdError` already has — `MissingVariantKeyError`'s docblock
 *  names this mapping as the one it was waiting for, since a row minted under
 *  an empty key could never be addressed, edited or deactivated again. Anything
 *  else rethrows and keeps its 500. */
function variantIdentityFailure(c: Context, err: unknown): Response {
	if (err instanceof MissingProductIdError) {
		return c.json({ error: "MISSING_PRODUCT_ID" }, 400);
	}
	if (err instanceof MissingVariantKeyError) {
		return c.json({ error: "MISSING_VARIANT_KEY" }, 400);
	}
	throw err;
}

/**
 * Wire shape of one variant, for both the list and the two write replies.
 *
 * `price` is an integer minor-unit amount plus an ISO-4217 string, and ABSENT
 * IS ABSENT: a variant with no price serializes `null` — never `0`, never a
 * zero-amount object. A cleared price (a resurrect whose currency no longer
 * matched the product's) is exactly that state, and rendering it as zero would
 * turn "nobody has priced this size" into "this size is free".
 *
 * `idempotencyKey` and `contentUpdatedAt` never cross this wire, matching the
 * narrowing `ProductVariantSummary` already applies to them: both are write-path
 * bookkeeping, and projecting them invites a caller to branch on machinery it
 * does not own. `updatedAt` stays — it is the compare-and-set watermark a later
 * edit must pass back.
 */
function serializeVariant(row: ProductVariant | ProductVariantSummary): Record<string, unknown> {
	return {
		productId: row.productId,
		variantKey: row.variantKey,
		sku: row.sku,
		price: row.price === null ? null : { amount: row.price.amount, currency: row.price.currency },
		title: row.title,
		// The orphan tombstone — a state a console must render distinctly rather
		// than hide, because an orphan may still hold units and sit on live orders.
		orphanedAt: row.orphanedAt === null ? null : row.orphanedAt.toISOString(),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * The LIST row: the shape above plus the stock signal the same statement joined.
 *
 * `onHand` IS DELIBERATELY NOT PROJECTED, and `inStock` stands in for it — the
 * same decision, and the same reason, as `unitCost`'s omission from the commerce
 * `GET` above. The write gate covers non-GET verbs only, so `GET
 * /products/:id/variants` is a storefront-reachable read, and an exact per-sku
 * stock count is operational data a buyer must not be handed. `inStock` is the
 * coarse display signal the catalog batch already publishes
 * (`ProductCommerceView.inStock`: `on_hand > 0` at read time, a join miss
 * reading false) — enough to grey out a size in a picker, and not a number
 * anyone can inventory the warehouse with. It is a PURCHASABILITY signal, not a
 * count, which is why folding the port's "unknown" (`null`) into `false` is
 * correct here and would be wrong on any surface that renders the number: a
 * size whose stock nobody knows is not one to offer. An admin surface that needs
 * the count reads it behind the internal token, where cost already lives.
 *
 * IT IS A STOCK SIGNAL ONLY, AND IT IS NOT PURCHASABILITY ON ITS OWN. `inStock`
 * reads `true` for a stocked size of a product that is unpublished, or even
 * soft-deleted — this projection knows about the variant row and its units, and
 * nothing about the row above it. Purchasability has always been a JOIN in this
 * codebase (`purchasable ⟺ commerce !== null && commerce.active`), decided by
 * the plugin and not by a store projection, and that is unchanged one level
 * down: a caller renders a size as buyable only when its PARENT's `active` says
 * the product is, and this field says the size has units. Reading `inStock`
 * alone offers sizes of products nobody has published.
 */
function serializeVariantSummary(row: ProductVariantSummary): Record<string, unknown> {
	return {
		...serializeVariant(row),
		inStock: row.onHand !== null && row.onHand > 0,
	};
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
