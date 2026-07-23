---
"@urumi/plugin": patch
---

Fix issue #82: pricing a product whose CMS content is ALREADY PUBLISHED left the
`product_commerce` row `active=false` — the storefront PDP stayed "Not currently
available for purchase" with no admin signal, and the only remedy was a manual
unpublish→republish. Activation was driven only by `content:afterPublish` →
`activateProductCommerce`, which for a "publish first, price later" product had
already fired (and no-op'd — the row did not exist yet) before the pricing write,
leaving no path to `active=true`.

What this change resolves:

- **The silent harm is gone.** When a `product_commerce` row is commerce-complete
  (sku + price) yet `active=false`, the Product-data panel now shows a lightweight
  "priced but not active — publish (or re-publish) to make purchasable" notice, so
  the state is visible and the remedy is named.
- **Auto-activation on the host-invoked content hooks.** `content:afterSave` and
  `content:afterPublish` both now activate a currently-PUBLISHED product's row via
  the DEDICATED, guarded `POST /products/:id/commerce/activate` route (never a
  field on the blanket `upsert`, which must never touch `active`/`deletedAt`).
  They share one publish idempotency key + ordering watermark, so the two hooks
  converge to a single applied flip and can never resurrect a SOFT-DELETED row
  (the store's `activate` no-ops on a tombstone — the load-bearing invariant,
  proven on SQLite + Postgres).

Honest limitation: **pricing alone does NOT instantly flip the row active.** The
row activates on the NEXT content save/republish of the published product (which
fires `content:afterSave`), and the panel indicator names exactly that remedy in
the meantime. Fully-automatic activation directly from the pricing action remains
a documented em-dash HOST follow-up: the stock admin renders the sandboxed
field-widget from static manifest elements and does not drive it through the
plugin's panel-state/route interaction pipeline, so the panel Save cannot yet
carry the document's publish signal back to the service. The plugin side of that
path (the panel-state route baking the signal into the Save button `value`, and
the route activating when it is present) is wired and tested, ready for when the
host threads it.

Capabilities stay exactly `content:read` + `network:request`; proven under the
workerd-on-Node sandbox.
