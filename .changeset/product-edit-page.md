---
"@urumi/domain": minor
"@urumi/store-postgres": minor
"@urumi/service": minor
"@urumi/plugin": minor
---

Standalone product edit page for the commerce-owned fields (admin-UX Increment 2,
slice 2). A proper Block Kit edit surface on the product detail leaf, escaping the
cramped field-widget panel, editing only the fields our commerce domain owns.

Ownership boundary (discovered, and enforced by scope): the CMS owns the product's
publish state (`active`, flipped by `content:afterPublish`/`afterUnpublish`) and
the content-side title/media; our domain owns price, currency, SKU, the commercial
title projection, tax class, product kind, and dimensions. `content:afterSave`
carries NO commercial fields (only an ordering watermark), so editing these is safe
— the sync never overwrites them. `active` is deliberately NOT editable here (a
merchant toggle would be fought by the next publish/unpublish sync); it is changed
by publishing the CMS document.

- **Domain** — a new guarded `ProductCommerceStore.updateCommerceFields(input,
  key, expectedUpdatedAt)` and its `updateProductCommerceFields` use-case.
  Optimistic compare-and-set on `updatedAt` (the `expectedFlag` precedent): a
  concurrent edit is a `stale` result the caller reloads on, never a silent
  clobber. Idempotent replay dedupes a double-submit; currency integrity is
  atomic (a price edit can never silently switch an already-priced product's
  currency); `price > 0` and non-negative dimensions are validated
  (`InvalidProductFieldError`). Never touches `active`/`deletedAt`/watermarks.
- **Adapters** — the fake and the Kysely store (sqlite + Postgres) implement the
  guarded update as a single atomic conditional `UPDATE` + a classify-the-no-op
  re-read, contract-pinned to identical guard order across all three.
- **Service** — `PATCH /admin/products/:id` mirroring the port under the
  X-Service-Token write gate (+ the admin X-Internal-Token): stale → 409
  `STALE_EDIT` with the current watermark, currency → 409 `CURRENCY_MISMATCH`,
  SKU collision → 409 `SKU_TAKEN`, non-positive price → 400, unknown → 404.
- **Plugin** — an edit form on the product detail leaf. Money is a TEXT input
  parsed to integer minor units by exact integer string math (never a Block Kit
  `number_input`, which hands back a JS float); currency is fixed for an
  already-priced product; a stale-edit conflict reloads the latest values with a
  re-apply notice.

The order-line snapshot invariant is preserved (structurally — an edit writes only
`product_commerce`, order lines are an independent snapshot) and pinned by a new
regression test: placing an order, editing the product's price + title, and
asserting the order's line items are byte-identical.
