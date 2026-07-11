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

/**
 * `content:afterPublish` (the afterPublish→activate follow-up, plan §6 step
 * 7) carries `content`/`updatedAt` (`ContentStateChangeEvent` — verified
 * against `~/em-dash`: the record is `contentItemToRecord(published item)`,
 * same shape `content:afterSave` gets). em-dash's own `publish()` bumps
 * `updated_at` on EVERY publish call — including an idempotent re-publish of
 * an already-published item (`content-repository.ts`'s `publish()`:
 * `updated_at = ${now}` unconditionally) — so `updatedAt` is monotonic across
 * publish/unpublish events.
 *
 * TWO distinct mechanisms use `updatedAt`, and they are complementary:
 *  - THIS idempotency key (`${collection}:${id}:published:${updatedAt}`)
 *    dedupes the SAME hook delivery firing twice (retry/at-least-once) — a
 *    redelivery carries the identical `content`, hence the identical
 *    `updatedAt` and key, so the store's per-row compare-on-write makes it a
 *    no-op.
 *  - the ORDERING WATERMARK (`updatedAt` sent as the body's `contentUpdatedAt`)
 *    handles a DIFFERENT problem: `activate`/`deactivate` are OPPOSING flips on
 *    the same `active` flag, so a stale publish delivered AFTER a newer
 *    unpublish must be rejected — the store gates on the watermark
 *    (`active_updated_at`) to converge out-of-order lifecycle delivery. A
 *    boolean flip DOES have a "which value is newer" question once opposing
 *    transitions race; the earlier claim that it did not was the bug this
 *    change fixes.
 * A `:published:` infix keeps this key-space disjoint from
 * `deriveSaveIdempotencyKey`'s (same `collection:id` prefix, different suffix),
 * since both share the store's single per-row `idempotencyKey` column.
 */
export function derivePublishIdempotencyKey(
	collection: string,
	id: string,
	updatedAt: unknown,
): string {
	return `${collection}:${id}:published:${String(updatedAt)}`;
}

/**
 * `content:afterUnpublish` (the afterUnpublish→deactivate follow-up, plan §6
 * step 7) — the exact mirror of `derivePublishIdempotencyKey`. Confirmed
 * against `~/em-dash`: `afterUnpublish` carries the SAME `{ content,
 * collection }` shape as `afterPublish`, its `content` being
 * `contentItemToRecord(unpublished item)` (`emdash-runtime.ts:2921`), so
 * `content.updatedAt` is present. em-dash's own `unpublish()` bumps
 * `updated_at = now` unconditionally
 * (`database/repositories/content.ts`'s `unpublish()`, lines 1269-1277), so —
 * exactly as for publish — `updatedAt` is monotonic across lifecycle events.
 * As for publish, `updatedAt` serves TWO complementary roles: THIS key dedupes
 * a SAME-delivery retry (identical `content` ⇒ identical key ⇒ per-row
 * compare-on-write no-op), while the ORDERING WATERMARK (sent as the body's
 * `contentUpdatedAt`) lets the store reject a stale unpublish delivered after a
 * newer publish — `deactivate` is the opposing flip to `activate` on the same
 * `active` flag, so it DOES need a "which value is newer" watermark to converge
 * out-of-order delivery (`active_updated_at`). An `:unpublished:` infix keeps
 * this key-space disjoint from the `:published:` and save keys (all share the
 * store's single per-row `idempotencyKey` column).
 */
export function deriveUnpublishIdempotencyKey(
	collection: string,
	id: string,
	updatedAt: unknown,
): string {
	return `${collection}:${id}:unpublished:${String(updatedAt)}`;
}
