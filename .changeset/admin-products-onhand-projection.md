---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Carry stock on the admin Products list projection, and the product title on the
low-stock report (admin-UX INC-03). The Pricing & inventory screen already
fetched a row per product but had to send the operator to the detail leaf to
learn whether anything was in stock; the low-stock report listed bare SKUs.

`ProductSummary` gains `onHand: number | null` and `LowStockRow` gains
`title: string | null`. Both are REQUIRED fields on exported interfaces, hence
`minor` for the packages that export them.

**`null` is not `0`.** `onHand: null` means there is no `inventory` record for
the sku — "unknown" — while `0` means a known sku that is out of stock. Nothing
on the path coerces between them, and both cases are pinned separately in the
contract suite against every adapter. This deliberately DIVERGES from
`InventoryStore.getOnHand`, which returns a bare `number` and so collapses the
two; the divergence is now documented on both sides of the port boundary.
`LowStockRow.title` falls back to `null` and NEVER to the sku, which is already
its own field on the row — substituting it would make "named SKU-42"
indistinguishable from "name unknown".

**Shape, chosen from measurements, not estimates.** Carrying stock on the list
projection itself was measured against the alternative of leaving each caller to
issue a per-row `getOnHand`: the N+1 cost several times the single joined read at
a 5,000-product catalog, in parallel and worse in sequence, on loopback and
before any real network. The projection is also unconditional rather than gated
on a "low stock only" filter — the gated variant measured *slower*, because it
must walk far more rows to fill a page.

The low-stock report's title half is the more expensive one, disclosed as such:
its cost is linear in CATALOG size rather than in the number of low-stock rows.
At a 5,000-product catalog that is comfortably inside the report's budget. Named
follow-up if low-stock latency ever matters: **bound the low-stock report** — it
currently returns every row at or below the threshold, unpaginated.

A soft-deleted product must not title a low-stock row or emit a second one.
Sku uniqueness is scoped to LIVE products, so a deleted product may legally hold
a sku a live product also holds; the report excludes deleted products from the
title lookup for that reason, and the exclusion is pinned by its own contract
case rather than left to the adapter.
