---
"@otta-sh/domain": minor
"@otta-sh/service": minor
"@otta-sh/plugin": minor
"@otta-sh/store-postgres": patch
---

**Breaking:** a product's title is now edited only in the CMS.

Renaming a product on the **Pricing & inventory** page used to write the commerce record
directly, and the next save of the CMS document silently put the old name back. The title now
has exactly one writer — the CMS content sync — so the two can no longer disagree. The page
still **shows** the title, as a read-only row beside Status, in the same shape and for the same
reason: publish state is the CMS's to set, and so is the name.

To rename a product, rename its CMS document. The new title appears in the console, on the
storefront and on new orders' line items after the next save. Existing orders are unaffected —
an order snapshots its line titles at purchase time and nothing rewrites them.

The commerce record keeps its `title` column. It is a cache of the CMS title, kept there so
placing an order never needs a read across the database boundary; dropping it was considered
and rejected, and the reasoning is recorded in
[ADR-0013](../adr/0013-product-title-is-cms-owned.md).

**Breaking API changes** (relevant if you integrate directly, not if you only use the console):

- `UpdateProductCommerceFieldsInput` (`@otta-sh/domain`) no longer has a `title` field.
- `PATCH /admin/products/:id` no longer accepts `title`. Its body schema is now **strict**: an
  unrecognised key is a `400` naming the field, rather than being silently dropped behind a
  `200`. Anything still sending `title` on that route will now fail on **every** edit, which is
  deliberate — a silently discarded rename is the failure this release removes.
- `PUT /products/:id/commerce` is **unchanged** and still accepts `title`. It is the CMS sync's
  channel and the one sanctioned writer.
