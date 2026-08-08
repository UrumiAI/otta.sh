---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
---

One commerce row per sellable unit: a product can now carry variants, keyed by the product plus a
stable variant key. Stock and price are SKU-level facts, so a size that can be bought on its own
is a row rather than a decoration on the product row — and it lands **inert**: with no variants
declared, which is the state of the entire catalog today, every existing statement, projection
and keyset cursor is byte-identical and the whole existing contract suite is untouched and green.

- **A separate `product_variants` table, and that is the load-bearing choice.** Widening
  `product_commerce` into one-row-per-unit would re-key its primary key and rewrite the products
  list, its cursor, both fakes and every caller, for a catalog in which nothing declares a
  variant. As its own table the eventual one-row-per-unit list is a LEFT JOIN that yields exactly
  one row per product until a variant exists, and its cursor **extends** the existing
  `(created_at, product_id)` position with `variant_key` rather than replacing it. The intra-
  product order is the key, which is why it is the key and not a timestamp.
- **Two writers that cannot reach each other's columns** (ADR-0016, ADR-0013 one level down). The
  CMS sync declares a variant and writes its display-name cache; the admin edit writes sku and
  price under a compare-and-set. `title` is absent from the edit input and `sku`/`price` are
  absent from the sync input, so crossing the line does not compile in either direction. The name
  cache ships **now**, with the model, because order lines freeze the variant's title at purchase
  time and anything written before the cache exists loses the size permanently.
- **The SKU-rename rule binds the variant writer unchanged**, because it is a property of the
  `sku` column and not of one caller: `inventory` is keyed by the bare sku and knows nothing about
  products or variants. Refuse while the source has live holds, claim-or-refuse the target, carry
  the count, retain the source zeroed — raced on Postgres at variant grain, including a rename
  against a concurrent seed of the target sku.
- **An orphan is a state, not an absence.** When the CMS stops declaring a key the row is
  deactivated, never deleted: it keeps its sku, its price, its stock and its place on live order
  lines, and a console can render it distinctly. A re-declared key resurrects it, stock intact —
  the deliberate divergence from publish-never-resurrects, since an orphan records the CMS's own
  statement rather than a merchant decision. Both transitions share one ordering watermark,
  because both ride the same save event.
- **A sku names exactly one live sellable unit**, spanning live product rows and live variant
  rows, so two names can never share one inventory row. A variant with no inventory row is
  absent, never zero; an absent price is absent, never `0`. Currency is an integrity axis one
  level down too: a size's price must agree with the product's, or — for a product whose sizes
  carry the money — with its siblings', serialized by a row lock so two first-pricings cannot
  leave one product holding two currencies.

No REST surface, no CMS sync and no console changes yet; those are separate changes on top of
this model.
