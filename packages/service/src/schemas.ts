import { z } from "zod";

// Zod request bodies mirroring the inventory port 1:1 (§0.6). `Idempotency-Key`
// travels as a header, not in the body.
export const reserveBody = z.object({
	sku: z.string().min(1),
	qty: z.number().int().positive(),
});

export const commitBody = z.object({
	reservationId: z.string().min(1),
});

export const releaseBody = z.object({
	reservationId: z.string().min(1),
});

// Cart bodies (§6). Money is intentionally absent — a cart line snapshots no
// price (that is an order invariant, Phase 4).
export const createCartBody = z.object({
	currency: z
		.string()
		.regex(/^[A-Z]{3}$/)
		.optional(),
});

export const addLineBody = z.object({
	sku: z.string().min(1),
	qty: z.number().int().positive(),
});

export const patchLineBody = z.object({
	qty: z.number().int().positive(),
});

// Path-parameter sanity (N3): ids are opaque tokens — non-empty, bounded, and
// free of whitespace/control characters. Routing guarantees non-empty; the
// bound and charset keep garbage out of the store layer.
const idParam = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7e]+$/);

export const pathParams = z.object({ cartId: idParam });
export const linePathParams = z.object({ cartId: idParam, lineId: idParam });

export type ReserveBody = z.infer<typeof reserveBody>;
export type CommitBody = z.infer<typeof commitBody>;
export type ReleaseBody = z.infer<typeof releaseBody>;

// Product-commerce (Phase 1 §7). Money on the wire is an integer + an
// ISO-4217 string — never a float (DEVELOPMENT.md §4). Every commercial
// field is optional: "create then price" (plan §1 case 3) — a bare sync
// upsert may carry only the product_id.
export const upsertProductCommerceBody = z.object({
	sku: z.string().min(1).optional(),
	price: z
		.object({
			amount: z.number().int().nonnegative(),
			currency: z.string().regex(/^[A-Z]{3}$/),
		})
		.optional(),
	taxClass: z.string().nullable().optional(),
	weightGrams: z.number().int().nullable().optional(),
	lengthMm: z.number().int().nullable().optional(),
	widthMm: z.number().int().nullable().optional(),
	heightMm: z.number().int().nullable().optional(),
	productKind: z.enum(["physical", "digital"]).optional(),
	// Initial stock (Phase 1 §8 Risk 4) — a create-if-absent seed attempted on
	// any save that carries it (self-healing after a partial failure, review
	// B1); never a restock path.
	initialOnHand: z.number().int().nonnegative().optional(),
	// Sync-ordering watermark (review S1): the CMS content's own updatedAt,
	// carried by content:afterSave syncs; a strictly-older value is a stale
	// no-op at the store. Panel saves omit it (last-writer-wins).
	// STRICT format (review F1): exactly `Date.toISOString()` output —
	// fixed-width UTC, so lexicographic comparison IS chronological. The
	// field feeds a raw text comparison in SQL; one garbage high-sorting
	// value (e.g. "ZZZZ") stored once would make every future legitimate
	// sync a stale no-op forever (panel saves preserve, never heal, the
	// watermark), so anything else is a 400 at the boundary.
	contentUpdatedAt: z
		.string()
		.regex(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
			"contentUpdatedAt must be a Date.toISOString()-format UTC timestamp",
		)
		.optional(),
});

// Publish-gate lifecycle actions (the afterPublish→activate /
// afterUnpublish→deactivate follow-ups). `contentUpdatedAt` is the CMS
// content's own `updatedAt` at publish/unpublish time — the ORDERING WATERMARK
// the store gates on so a stale, out-of-order lifecycle POST is a no-op
// (activate/deactivate are opposing flips on the same `active` flag delivered
// by independent fire-and-forget hooks). REQUIRED and STRICT — exactly
// `Date.toISOString()` output (same rationale as `upsert`'s contentUpdatedAt,
// review F1: it feeds a raw lexicographic SQL comparison; a garbage
// high-sorting value would wedge the gate). EmDash's publish()/unpublish()
// always carry it, so it is never legitimately absent.
export const lifecycleProductCommerceBody = z.object({
	contentUpdatedAt: z
		.string()
		.regex(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
			"contentUpdatedAt must be a Date.toISOString()-format UTC timestamp",
		),
});

export type LifecycleProductCommerceBody = z.infer<typeof lifecycleProductCommerceBody>;

// Catalog batch read (Phase 2 §6): ids are opaque tokens, same charset/bound
// discipline as the cart path params; the array-length cap is the endpoint's
// request-size guard (COMMERCE_BATCH_ID_CAP in routes/catalog.ts — kept in
// sync by the route's own 400 test).
export const commerceBatchBody = z.object({
	productIds: z
		.array(
			z
				.string()
				.min(1)
				.max(200)
				.regex(/^[\x21-\x7e]+$/),
		)
		.max(100),
});

export type CommerceBatchBody = z.infer<typeof commerceBatchBody>;
export type UpsertProductCommerceBody = z.infer<typeof upsertProductCommerceBody>;
export type CreateCartBody = z.infer<typeof createCartBody>;
export type AddLineBody = z.infer<typeof addLineBody>;
export type PatchLineBody = z.infer<typeof patchLineBody>;
