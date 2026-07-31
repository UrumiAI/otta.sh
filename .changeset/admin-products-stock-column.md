---
"@otta-sh/plugin": minor
---

Show inventory on the screen named for it: the admin Pricing & inventory list gains
an `On hand` column and a "Low stock only" filter, and the product detail badges its
stock (admin-UX INC-04). Until now the columns were Title / SKU / Status / Price and
the subtitle admitted "stock is on the detail", so "something is sold out — find it
and restock it" had to start on the Reports screen, from a collapsed accordion of
bare SKUs, and the SKU→title mapping lived in the operator's head.

- **`On hand` column**, between Status and Price — money stays LAST and
  pre-formatted. Three wire cases stay three cases: a count renders as a count,
  `null` (the sku has no inventory record) renders `—`, and a response carrying no
  stock at all renders `—` in every cell plus one alert banner, inside a 200. `null`
  and `0` are never folded together, in either direction.
- **The exceptions are badged, and only the exceptions**: `0` reads
  `0 · Out of stock`, `1..threshold` reads `3 · Low`, and anything above the
  threshold is a plain count. The badge rides in the cell's own text because the
  table keeps ONE badge column and it is Status; the same helper renders the
  detail's `Stock on hand` and its Stock panel, so a product cannot read low in one
  place and plain in another.
- **"Low stock only"** is a fourth filter field (a toggle, not a fifth select — the
  filter panel is already tall), and it behaves like the filters beside it: it
  counts toward the accordion's active-filter label, shows in the filter summary,
  and rides the list cursor so `Load more` keeps it applied. It narrows the FETCHED
  PAGE rather than the query: the products list has no stock predicate, and the
  measurement behind the on-hand projection chose one unconditional join over a
  gated one precisely because the gated shape had to walk ~9x the rows to fill a
  page. A row with no inventory record is never "low", only unknown.
- **The threshold comes from the store's settings** (`lowStockThreshold`), read
  alongside the page and alongside the detail's tax-class registry. It is a
  SECONDARY read in both places: when it fails, a count still renders and `0` still
  reads `Out of stock` — only the `Low` band is unknown — and a "Low stock only"
  request that cannot be honoured lists everything and says so rather than showing a
  quietly wrong set of rows. No form field for the threshold appears here: it has one
  home, on Settings.
- **The product picker label is now `<title> · <sku> · <status>`.** The separator was
  ` — `, which collided with a title's own em-dash — `Washed Linen Apron — Natural —
  active` reads as three fields of which two are the title — and the SKU was absent
  from the one control keyed by title, which is why low-stock SKUs had to be
  translated by hand. A null sku drops its segment rather than rendering a dash, and
  a null title reads `(untitled)` rather than the product id.

No service, wire, or schema change: this is the console rendering `onHand`, which the
admin products list projection already carries.
