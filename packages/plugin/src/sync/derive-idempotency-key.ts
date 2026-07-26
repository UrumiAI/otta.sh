/**
 * Idempotency-key derivation for a content sync (plan §4 / §8 Risk 1).
 *
 * Resolution of Risk 1: `content.updatedAt` is the field the key is built from,
 * because EmDash bumps it on EVERY content write — `ContentRepository.update()`
 * sets `updated_at: now` (and `version: version + 1`) unconditionally, with no
 * "did any column actually change" gate. So the key is
 * `${collection}:${id}:${updatedAt}`: re-DELIVERING the same hook event (the
 * same `updatedAt`) dedupes against the store's per-row compare-on-write, while
 * a genuinely newer write bumps `updatedAt` and produces a fresh key that
 * applies.
 *
 * CORRECTION (publish atomicity, plan §1.3/§5 F2). An earlier version of this
 * comment claimed `version` is "in `SYSTEM_COLUMNS` and stripped by
 * `rowToContentItem()` before reaching a plugin". That is FALSE on the deployed
 * `emdash@0.29.0`: `version` is stripped from the `data` bag but RE-EMITTED as a
 * top-level field by `mapRow`, alongside `liveRevisionId`/`draftRevisionId`, and
 * `contentItemToRecord = { ...item }` passes it through — a plugin does receive
 * it. It is deliberately still not used here: on 0.29.0 `updatedAt` alone is
 * already strictly monotonic per write, so `version` would add nothing. It
 * becomes load-bearing only if Urumi ever upgrades to a build carrying the
 * upstream `hasColumnWrites` gate (#2143), where successive no-op-column draft
 * saves would share one `updatedAt` and collapse to a single applied upsert.
 *
 * DESPITE THE NAME, this is not the afterSave key-space only. Since publish
 * atomicity, `content:afterPublish` also derives the commerce upsert and keys it
 * HERE, on the publish's own bumped `updatedAt` — deliberately in this
 * key-space rather than the `:published:` one, because the publish's upsert and
 * its activate are two separate writes against a single per-row
 * `idempotency_key` column and must not collide (see
 * `derivePublishIdempotencyKey` and plan §2.9 / #94).
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
