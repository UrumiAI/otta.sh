---
"@urumi/plugin": minor
---

One home per field: the CMS no longer stores commercial data.

**Breaking (public API):** `@urumi/plugin` no longer exports `buildProductDataElements` or
`productDataWidget` — the "Product data" Block Kit field widget is deleted, so a site
descriptor that registered it (`fieldWidgets: [productDataWidget]`) must drop that entry.

Pricing used to live in **two** places. The "Product data" Block Kit panel wrote sku, price,
currency, stock, kind, tax class and dimensions into a `commerce` JSON field on the CMS content
document, and the sync hooks projected that into `product_commerce` on every save and publish.
The admin console's **Pricing & inventory** page wrote the same columns directly. Two writers,
one set of columns — so any publish of a product reverted whatever the merchant had just edited
in the console, even when the content change was unrelated. That reversion has been pinned as a
deliberately-failing store-contract case (`KNOWN GAP (F4)`) since it was found; this release
replaces it with its inverse.

**Commercial fields now have exactly one home: `product_commerce`, edited only in Pricing &
inventory.** The panel, its seed field and its validator are deleted. `content:afterSave` and
`content:afterPublish` become lifecycle-only except for one thing.

**The title keeps syncing, permanently.** `product_commerce.title` stays as an explicitly
labelled **derived, single-writer cache** whose only writer is the CMS content sync. It exists so
an order line can snapshot a product's name without a cross-database read, which the architecture
forbids. The CMS `products` collection owns the value; nothing else may write it.

Behavioural changes worth knowing:

- **Every CMS product now appears in Pricing & inventory.** The sync used to refuse to create a
  row for a product with no sku, so a product created in the CMS and not yet priced was
  *invisible* in the console and there was no way to price it at all. Now every save mints a bare
  row, unpriced and ready.
- **A published, never-priced product is now `active: true`.** That state could not previously
  occur. It is not purchasable: the catalog read filters commerce-incomplete rows, so nothing
  joins to it. It still appears on `/products` — that grid comes from your CMS content — but with
  no price, no add-to-cart and a "not currently available" note. The console's status column says
  `active (not priced)` rather than a misleading `active`.
- **REGRESSION, named plainly:** a content-only CMS save (a description edit, an image swap) now
  bumps `product_commerce.updated_at` and can show a spurious *"This product changed since you
  opened it"* on an open Pricing & inventory form. The recovery verb is reloading the form.
  This did not happen before. The obvious fix — deriving the sync's idempotency key from its
  payload so an unchanged title replays — is **wrong** and must not be attempted: the replay
  guard and the ordering-watermark guard sit on the same conditional update, so a same-key no-op
  would freeze `content_updated_at` and let a reordered older save win permanently, corrupting
  the value order lines snapshot. The correct fix is in the store adapter, tracked as issue #153.
- No migration. No change to `PUT /products/:id/commerce`, which keeps carrying `title` — it is
  the sync's channel.

**Upgrading.** Removing the field from the seed does not remove it from a database that already
has it: EmDash's seed applier creates and updates fields but never deletes one the seed stopped
declaring. If your site was seeded before this release, the Products collection keeps an unused
"Commerce" JSON field showing the old pricing data, rendered as a raw JSON textarea. It is
ignored — pricing now lives in **Pricing & inventory**. Remove it with
`emdash schema remove-field products commerce`. That command drops the field record, re-syncs the
search triggers and **drops the column and its data** in one transaction, so check your prices in
Pricing & inventory first — it cannot be undone. It works against a deployed site over HTTP with
`--url`. **On a fresh install it is not a no-op: it fails with `Field "commerce" not found` and a
non-zero exit**, so do not run it unconditionally from an upgrade script.

**Quickstart.** The seed applier fires no content hooks, so the three demo products have never
produced a commerce row — before or after this change. `sites/staging/scripts/seed-demo-commerce.ts`
now prices, stocks and activates them, resolving each product's real content id from the CMS by the
slug `seed/seed.json` declares (a seed entry's declared `id` is a seed-local reference; EmDash
stores a generated ULID). It is safe to re-run: each product is read first and skipped if it
already has a SKU, so it never overwrites a price a merchant set.
