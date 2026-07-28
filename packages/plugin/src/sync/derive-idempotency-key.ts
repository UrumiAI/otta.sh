/**
 * Idempotency-key derivation for a content sync (plan §4 / §8 Risk 1).
 *
 * The key is `${collection}:${id}:${updatedAt}:${version}`. Re-DELIVERING the
 * same hook event replays the identical record — hence the identical key — and
 * dedupes against the store's per-row compare-on-write, while a genuinely newer
 * write produces a fresh key that applies.
 *
 * WHY `version` IS IN THE KEY (the contingency arrived). This comment used to
 * say `version` was "deliberately still not used here", because on
 * `emdash@0.29.0` `ContentRepository.update()` stamped `updated_at: now`
 * unconditionally, so `updatedAt` alone was already strictly monotonic per
 * write. It named the exact condition that would change that: "a build carrying
 * the upstream `hasColumnWrites` gate (#2143), where successive no-op-column
 * draft saves would share one `updatedAt`".
 *
 * That build is `emdash@0.30.0` (commit `8d6b20b`, "Fixes #2143"). `update()`
 * now stamps `updated_at` ONLY when the write touches a real column:
 *
 *     const hasColumnWrites = Object.keys(updates).length > 0;
 *     if (hasColumnWrites) updates.updated_at = now;
 *     updates.version = sql`version + 1`;          // still UNCONDITIONAL
 *
 * On a revision-supporting collection (`products` declares `revisions`) the
 * editor's Save routes all data into draft storage and reaches `update()` with
 * an empty column set, so `updatedAt` FREEZES across successive saves. Keying on
 * `updatedAt` alone therefore made every price edit after the first collapse
 * onto one key, and `upsert`'s guard 1 (`WHERE product_commerce.idempotency_key
 * != :key`) silently dropped it — real money loss on the "price an unpublished
 * product, then change the price" path.
 *
 * `version` restores the invariant `updatedAt` used to carry, and is the right
 * component because it is (a) bumped unconditionally on every update, including
 * the column-no-op draft save above; (b) present top-level on the hook record —
 * `mapRow` emits it and `contentItemToRecord = { ...item }` passes it through,
 * at both call sites; and (c) identical across a redelivery, because em-dash
 * captures ONE `content` record per write and hands that same object to every
 * hook consumer (`runAfterSaveHooks` / `runDeferredContentHook`) with no per-
 * delivery DB re-read — so replay dedupe still holds.
 *
 * A host that does not emit `version` at all keeps the pre-change key BYTE-FOR-
 * BYTE, so this degrades exactly like `hasPendingDraft` does for absent revision
 * pointers: older/different hosts see no behavior change.
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
	version?: unknown,
): string {
	const base = `${collection}:${id}:${String(updatedAt)}`;
	// Absent `version` ⇒ the pre-change key, unchanged. Only a host that
	// actually emits it opts into the extra component.
	return version === undefined || version === null ? base : `${base}:${String(version)}`;
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
