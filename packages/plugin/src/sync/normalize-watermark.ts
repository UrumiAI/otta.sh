/**
 * Normalize a CMS `updatedAt` (string or Date-serializable) to strict
 * `Date.toISOString()` form, or `undefined` when unparseable.
 *
 * The service validates the ordering watermark EXACTLY as `Date.toISOString()`
 * output (review F1 — it feeds a raw lexicographic SQL comparison), so every
 * producer of a watermark (the content-sync hooks AND the admin panel's
 * activate-on-price seam) funnels through this one normalizer: whatever date
 * shape the CMS hands us is coerced to the canonical form, and an unparseable
 * value omits the watermark (a bare, ungated write) rather than failing the
 * whole sync on a 400. Shared so the two call sites can never drift.
 */
export function normalizeWatermark(updatedAt: unknown): string | undefined {
	if (typeof updatedAt !== "string" && typeof updatedAt !== "number") return undefined;
	const parsed = new Date(updatedAt);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
