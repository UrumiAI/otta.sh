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
	// Initial stock (Phase 1 §8 Risk 4) — only consumed the moment a sku is
	// first set; never a restock path.
	initialOnHand: z.number().int().nonnegative().optional(),
});

export type UpsertProductCommerceBody = z.infer<typeof upsertProductCommerceBody>;
