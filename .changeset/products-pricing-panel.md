---
"@otta-sh/admin-react": minor
"@otta-sh/plugin": minor
---

Price and stock move into the products collection's own screens; the separate Pricing & inventory page leaves the sidebar (ADR-0014, amendment 2026-10-01).

**`@otta-sh/admin-react`** exports a **Pricing & stock** content editor panel and **Price** / **Stock** content-list columns for the `products` collection. The panel edits price (with a currency picker for an unpriced product), compare-at price with a sale preview, cost with profit and margin, SKU, stock (one-click add, remove with a confirm), product type, tax class, weight and size, behind one Save. A draft survives the re-read a CMS save causes; a SKU refusal keeps what was typed beside the SKU; a "someone saved first" refusal shows the latest values. The columns share one read per list page. Both are shown to admins only (`minRole: 50`), as the route behind them requires `plugins:manage`. The `/products` console page is no longer registered.

**`@otta-sh/plugin`** adds a `products.summaries` read on the existing `otta` admin route — price, compare-at and on-hand for a bounded list (1–100) of product ids, in order, with `null` on-hand kept distinct from zero — and a single `products:save` action that writes every field the panel owns through the existing sparse save. Refusals become machine-readable for the panel: a stale save carries `recordMoved: true`, and "SKU already in use" now names the `sku` field like the two rename refusals.
