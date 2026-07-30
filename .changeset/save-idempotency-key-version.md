---
"@otta-sh/plugin": patch
---

Include the content record's `version` in the save idempotency key
(`${collection}:${id}:${updatedAt}:${version}`), so a price edit can no longer
be silently dropped on EmDash >= 0.30.0.

`deriveSaveIdempotencyKey` assumed `content.updatedAt` moves on every write.
EmDash `8d6b20b` ("draft-only saves no longer bump updated_at on published
entries", #2143, shipped 0.30.0) ended that: `ContentRepository.update()` now
stamps `updated_at` only when the write touches a real column, while still
bumping `version` unconditionally. On a revision-supporting collection —
`sites/staging`'s `products` declares `revisions` — the editor's Save routes all
data into draft storage and reaches `update()` with an empty column set, so
`updatedAt` FREEZES across successive saves.

The visible bug: on the "price a product before publishing" path (the one
`content:afterSave` still syncs immediately under publish atomicity), the first
save applied and every later price edit derived the SAME key, which
`ProductCommerceStore.upsert` discards via its replay guard
(`WHERE product_commerce.idempotency_key != :key`). Set 1500, save; change to
2000, save — the 2000 was lost with no error anywhere.

`version` restores the invariant `updatedAt` used to carry: it is bumped on
every update including the column-no-op draft save, it is present top-level on
the hook record at both call sites (`mapRow` emits it, `contentItemToRecord` is
`{ ...item }`), and it is identical across a redelivery — EmDash captures one
`content` record per write and hands that same object to every hook consumer
with no per-delivery re-read — so replay dedupe is unchanged.

A host that emits no `version` keeps the previous key byte for byte, matching
how `hasPendingDraft` already degrades for absent revision pointers.

**Patch, not minor:** no exported signature changes for existing callers — the
new `version` parameter is optional and omitting it reproduces the old key
exactly — and no behavior changes on any host where `updatedAt` was already
per-write monotonic. This restores intended behavior on newer EmDash rather than
adding capability.

Bundled with the `sites/staging` EmDash 0.29.0 -> 0.31.1 bump because it is a
prerequisite of it: shipping that bump alone introduces the data loss above.
The bump itself needed no changeset (`sites/staging` is private and no published
package changed); this commit does, because it changes the published
`@otta-sh/plugin`.
