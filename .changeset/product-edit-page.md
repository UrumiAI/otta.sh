---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Standalone product edit page for the commerce-owned fields (admin-UX Increment 2,
slice 2). A proper Block Kit edit surface on the product detail leaf, escaping the
cramped field-widget panel, editing only the fields our commerce domain owns.

Ownership boundary (discovered, and enforced by scope): the CMS owns the product's
publish state (`active`, flipped by `content:afterPublish`/`afterUnpublish`), its
title, and its media; our domain owns price, currency, SKU, tax class, product kind,
and dimensions. `content:afterSave` carries no commercial fields — only the title and
an ordering watermark — so editing the commercial ones is safe: the sync never
overwrites them. `active` and the title are deliberately NOT editable here (a merchant
edit would be fought by the next publish/save sync); `active` changes by publishing the
CMS document and the title by renaming it.

- **Domain** — a new guarded `ProductCommerceStore.updateCommerceFields(input,
  key, expectedUpdatedAt)` and its `updateProductCommerceFields` use-case.
  Optimistic compare-and-set on `updatedAt` (the `expectedFlag` precedent): a
  concurrent edit is a `stale` result the caller reloads on, never a silent
  clobber. Idempotent replay dedupes a double-submit; currency integrity is
  atomic (a price edit can never silently switch an already-priced product's
  currency); a sku already held by another live product is a typed `SKU_TAKEN`
  rejection; `price > 0` and non-negative dimensions are validated
  (`InvalidProductFieldError`). Never touches `active`/`deletedAt`/watermarks.
  The guarded update is a single atomic conditional write plus a
  classify-the-no-op re-read, contract-pinned so every adapter applies the
  guards in the same order and a stale edit reports the current watermark.
- **Plugin** — an edit form on the product detail leaf. Money is a TEXT input
  parsed to integer minor units by exact integer string math (never a Block Kit
  `number_input`, which hands back a JS float); currency is fixed for an
  already-priced product; a stale-edit conflict reloads the latest values with a
  re-apply notice.

The order-line snapshot invariant is preserved (structurally — an edit writes only
`product_commerce`, order lines are an independent snapshot) and pinned by a new
regression test: placing an order, then changing the product's price through this
edit path *and* its title through the CMS sync, and asserting the order's line items
are byte-identical.
