/**
 * Idempotency-key derivation for a content sync (plan §4 / §8 Risk 1).
 *
 * Resolution of Risk 1: `ContentHookEvent`/`ContentItem` exposes no stable
 * revision counter or hash to a plugin (verified against `~/em-dash` — the
 * raw DB row's `version` column is in `SYSTEM_COLUMNS` and stripped by
 * `rowToContentItem()` before reaching a plugin, trusted or sandboxed). The
 * only stable, monotonically-changing field a plugin actually receives is
 * `content.updatedAt` (bumped on every write). The key is therefore
 * `${collection}:${id}:${updatedAt}` — re-firing the SAME save (same
 * `updatedAt`) dedupes; a genuinely newer edit bumps `updatedAt` and
 * produces a fresh key that applies.
 */
export function deriveSaveIdempotencyKey(
	collection: string,
	id: string,
	updatedAt: unknown,
): string {
	return `${collection}:${id}:${String(updatedAt)}`;
}

/**
 * `content:afterDelete` carries no `content`/`updatedAt` (only
 * `id`/`collection`/`permanent` — em-dash `ContentDeleteEvent`). A stable
 * per-id key is sufficient here: `ProductCommerceStore.softDelete` is
 * ALREADY an unconditional no-op once `deletedAt` is set (plan §4),
 * independent of the key, so the key only needs to make repeated deletes of
 * the SAME id collapse to one applied write — which a fixed suffix does.
 */
export function deriveDeleteIdempotencyKey(collection: string, id: string): string {
	return `${collection}:${id}:deleted`;
}
