---
"@urumi/plugin": patch
---

Rework the admin "Product data" pricing widget from a broken button-bearing
Block Kit tree to inline field inputs, and derive `product_commerce` on save.

em-dash renders a sandboxed field widget through `BlockKitFieldWidget`, which
supports ONLY `text_input`/`number_input`/`toggle`/`select`/`media_picker` and
has an `onChange`-only contract (NO button/action round-trip). The old panel
emitted a `type:"button"` (Save) into the field widget, so it rendered the SKU
field then died on the unsupported button — Price/Currency/Stock/Save never
appeared. This is structural across installed/fork/upstream em-dash, not fixable
by a version bump.

- `admin/product-data-widget.ts`: the widget is now a STATIC tree of supported
  inline inputs only (SKU, price in integer minor units, currency, initial
  on-hand, product kind, tax class, dimensions) — no button, no unsupported
  element. em-dash fills each input's value from the stored `commerce` field
  JSON keyed by `action_id` and persists it on the editor's native Save; there
  is no live-state fetch, so the tree carries no `initial_value`/`disabled`
  (em-dash ignores both for a field widget). Guidance rides in labels/
  placeholders (a non-input banner would render "Unsupported"); the old
  "priced but not active" indicator is dropped — saving a published product now
  activates it in the same operation, so that window largely no longer opens.
- `sync/hooks.ts` (`content:afterSave`): now the SINGLE write path. Reads
  `content.data.commerce`, validates it through the shared
  `parseCommerceFields` guard, and upserts the derived commercial fields +
  ordering watermark. MONEY INTEGRITY: a float price (em-dash `number_input` can
  yield a decimal) or invalid field skips the whole upsert and logs — no float
  ever reaches a money field and the CMS save still succeeds. A missing/empty
  SKU skips the upsert (no partial row). Stock rides as create-if-absent
  `initialOnHand`, so a re-save never clobbers inventory-managed on-hand. When
  the saved product is published, the row is activated in the same sync through
  the guarded `/activate` (never an `active` field on the upsert), converging on
  the shared publish idempotency key/watermark so it never double-flips and a
  soft-deleted row is never resurrected (issue #82).
- `product-commerce/parse-commerce-fields.ts`: new IO-free validator extracted
  verbatim from the retired route's `validate()`, shared by afterSave.
- Retires the button-era `admin/product-commerce-route.ts` (the form-submit save
  path) and its exports; `admin/panel-state-route.ts` is kept only as a
  diagnostic read (em-dash never routes a field widget through it).

The plugin stays sandbox-clean (service only via `ctx.http` + `allowedHosts`,
write-gate token unchanged) and never imports `@urumi/domain`.
