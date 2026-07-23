---
"@urumi/plugin": patch
---

Fix issue #82: pricing a product whose CMS content is ALREADY PUBLISHED left the
`product_commerce` row `active=false` — the storefront PDP stayed "Not currently
available for purchase" until a manual unpublish→republish. Activation was driven
only by `content:afterPublish` → `activateProductCommerce`, which for a
"publish first, price later" product already fired (and no-op'd — the row did not
exist yet) before the pricing write, leaving no path to `active=true`.

The primary, host-wired fix is in the `content:afterSave` sync hook (fires on
every document save, carrying the content record's `status`): when the saved
product is CURRENTLY PUBLISHED, the hook now activates the (possibly just-created)
row in the same sync via the DEDICATED, guarded `POST /products/:id/commerce/activate`
route — never a field on the blanket `upsert` (which must never touch
`active`/`deletedAt`). It reuses the publish idempotency key + ordering watermark,
so it converges with the real `content:afterPublish` to one applied flip and can
never resurrect a SOFT-DELETED row (the store's `activate` no-ops on a tombstone —
the load-bearing invariant, proven on SQLite + Postgres). The `product-commerce`
panel Save route applies the same guarded activation when the panel carries the
document's publish signal (baked into the Save button's `value` by the
`product-data/panel-state` route and echoed back on submit). All activation is
best-effort like the fire-and-forget sync hooks: the row is durably priced
regardless, and a missing/false publish signal or unparseable watermark skips
activation (no ungated flip).

Also adds issue #82's option-2 admin signal: when a `product_commerce` row is
commerce-complete (sku + price) yet `active=false`, the Product-data panel now
shows a lightweight "priced but not active — publish to make purchasable" notice
so a lost activation is never silent. Capabilities stay exactly `content:read` +
`network:request`; proven under the workerd-on-Node sandbox.
