---
"@otta-sh/plugin": patch
---

Reports low-stock table: carry the product title (admin-UX INC-05). The wire
already carried `LowStockRow.title` (INC-03), but the Reports screen never
read it — an operator staring at a bare `SKU-A` still had to keep a
SKU-to-title map in their head to know what was running out.

The `reports:low-table` columns change from `SKU` -> `On hand` to `Title` ->
`SKU` -> `On hand`. A `null` title renders `(untitled)`, and never falls
back to the SKU, which is already its own column on the row.

`On hand` states `0 / Out of stock` at zero and `<n> / Low` otherwise — the
exact wording from the stock-visibility increment's (INC-04) own
verification note in the spec, which is the vocabulary source. That
increment's `products-page.ts` `On hand` column has not merged as of this
change, so this is not a mirror of shipped code; when it lands, its column
is this one's sibling, not its source. Deliberately plain text rather than
`format: "badge"`: every row here already sits at or below some threshold
by construction of `GET /reports/low-stock`, so a badge column could
legitimately render the identical value on every row in a given response —
exactly the case `ADMIN-CONSOLE.md`'s X-4 (T-5) forbids. Presentation only:
no port, wire-format, or money-handling change.
