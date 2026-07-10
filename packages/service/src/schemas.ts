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
