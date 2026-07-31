---
"@otta-sh/domain": minor
"@otta-sh/service": minor
"@otta-sh/plugin": minor
"@otta-sh/store-postgres": patch
---

Carry stock on the admin Products list projection, and the product title on the
low-stock report (admin-UX INC-03). The Pricing & inventory screen already
fetched a row per product but had to send the operator to the detail leaf to
learn whether anything was in stock; the low-stock report listed bare SKUs.

`ProductSummary` (and the `GET /admin/products` wire) gains `onHand: number |
null`, and `LowStockRow` (and `GET /reports/low-stock`) gains `title: string |
null`. Both are REQUIRED fields on exported interfaces, hence `minor` for the
packages that export them; `store-postgres` changes adapter behaviour only and
stays `patch` — the same split as `title-single-writer`.

**`null` is not `0`.** `onHand: null` means there is no `inventory` record for
the sku — "unknown" — while `0` means a known sku that is out of stock. Nothing
on the path coerces between them, and both cases are pinned separately in the
contract suite against every adapter. This deliberately DIVERGES from
`InventoryStore.getOnHand`, which returns a bare `number` and so collapses the
two; the divergence is now documented on both sides of the port boundary.
`LowStockRow.title` falls back to `null` and NEVER to the sku, which is already
its own field on the row — substituting it would make "named SKU-42"
indistinguishable from "name unknown".

**Shape, chosen from measurements, not estimates.** Postgres 16, 5,000 products
/ 3,997 inventory rows (~20% deliberately carrying no inventory record).

*Products list, page size 25* — a single unconditional `LEFT JOIN` costs p50
0.43 → 0.58 ms and p95 0.61 → 0.91 ms, where an N+1 of per-row `getOnHand` reads
cost 2.60 ms p50 in parallel and 6.36 ms sequential: 6x and 15x the baseline, on
loopback, before any real network. The join is therefore unconditional rather
than gated on a "low stock only" filter — the gated variant measured *slower*
(1.15 ms), because it must walk ~9x the rows to fill a page. **No index and no
migration**: the join's inner side is already `inventory`'s primary key, and a
covering index cut buffers 28% without moving wall-clock at all.

*Low-stock report* — the title join is the more expensive half, disclosed as
such: p50 2.915 → 4.858 ms (+67%), p95 6.89 → 7.48 ms. The planner picks a Hash
Right Join whose build side is a **Seq Scan over `product_commerce`**, so this
query's cost is linear in CATALOG size, not in the number of low-stock rows. At
5,000 products that is 121 shared buffers and ~3.4 ms of execution, comfortably
inside the report's budget. The partial unique index
`product_commerce_live_sku_unique` remains available to the planner and should
flip it to a nested-loop index lookup once the catalog grows enough for the seq
scan to lose. No index was added, per the user's ruling on §5.1. Named follow-up
if low-stock latency ever matters: **bound the low-stock report** — it currently
returns every row at or below the threshold, unpaginated — before reaching for
an index.

`lowStock`'s title join carries `AND product_commerce.deleted_at IS NULL` on its
ON clause. That predicate is load-bearing, not defensive: sku uniqueness on
`product_commerce` is a PARTIAL unique index over live rows, so a soft-deleted
product may legally hold a sku a live row also holds — without the predicate
such a sku would emit a DUPLICATE low-stock row and could be titled by the dead
product. Pinned by a contract case and an HTTP case on both dialects.
