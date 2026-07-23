---
"@urumi/plugin": patch
---

Fix issue #82: pricing a product whose CMS content is ALREADY PUBLISHED left the
`product_commerce` row `active=false` — the storefront PDP stayed "Not currently
available for purchase" until a manual unpublish→republish. Activation was driven
only by `content:afterPublish` → `activateProductCommerce`, which for a
"publish first, price later" product already fired (and no-op'd — the row did not
exist yet) before the pricing write, leaving no path to `active=true`.

The `product-commerce` panel Save route now activates the just-priced row in the
SAME operation when the panel reports the content is currently published, via the
DEDICATED, guarded `POST /products/:id/commerce/activate` action route — never a
field on the blanket `upsert` (which deliberately never touches
`active`/`deletedAt`). Routing through `activate` preserves the load-bearing
invariant that a SOFT-DELETED row is never resurrected (the store's `activate`
no-ops on a tombstone), so the fix cannot reintroduce the stale-reactivation
hazard the upsert rule protects. Activation is best-effort like the fire-and-forget
sync hooks: the row is durably priced regardless, and a missing/false publish
signal or unparseable watermark skips activation (no ungated flip — an unpublished
product's row correctly stays inactive until `content:afterPublish`). A replay of
the same pricing submission derives the same activate idempotency key, so the store
dedupes to one applied flip.

The publish signal is threaded end-to-end without new capabilities: the
`product-data/panel-state` route bakes the document's publish state + `updatedAt`
watermark into the Save button's `value`, which the host echoes back into the
`product-commerce` route input on submit. Capabilities stay exactly
`content:read` + `network:request`; proven under the workerd-on-Node sandbox.
