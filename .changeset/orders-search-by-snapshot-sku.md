---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/admin-presentation": patch
"@otta-sh/admin-react": patch
"@otta-sh/service": patch
---

Orders search gains a third axis: the SKU frozen onto an order's lines at purchase time.
`OrderListFilter.search` now matches an order-id PREFIX **or** a `buyer_ref` SUBSTRING **or** an
EXACT (case-folded) line sku, ORed. Nothing that matched before stops matching — the two existing
halves are untouched — and the wire is unchanged: one search box, one `search` param, one more
thing it can find.

The Orders list's search box now says so: **Search order ID, buyer email, or exact SKU**. A search
axis the label does not name ships dark — nobody types into a box for a thing they have no reason
to think it reads — so the label change is part of the feature, not a follow-up. It spends exactly
one mode word, on the one axis whose mode changes what to type: a partial id or email still finds
the order, a partial SKU finds nothing. That is the same principle behind the products list's
`Search (SKU exact, or title contains)`, and both labels are now pinned side by side, plus a
mounted check that the sentence actually reaches the control an operator types into.

`@otta-sh/service` is bumped because its `GET /admin/orders` answers differently for the same
query, though no service source changed — only its test coverage. `@otta-sh/admin-presentation`
and `@otta-sh/admin-react` are bumped for the label. `@otta-sh/plugin` is NOT bumped: it forwards
`search` verbatim, and the Orders list it renders is the React one.

- **The purchase-time snapshot, not the live catalogue.** The sku compared is the one on the
  order's own lines — the insert-once snapshot the detail screen renders. Renaming a product's sku
  therefore leaves every earlier order findable under the sku it was bought as, and moves none of
  them onto the new one. A sku that exists only in the catalogue, on nothing anybody ordered,
  matches no order at all. Both directions are pinned in the contract, and the second again over
  the wire.
- **Exact, not a prefix and not a substring.** A sku is an identifier an operator pastes whole off
  a packing slip or a ticket, and exactness is the settled house rule for skus everywhere else:
  the products list already matches an exact-lower sku beside its substring title, and the orders
  `customer` key keeps exact-lower `buyer_ref` for the same identity reason. A substring would
  drag a whole variant family (`TEE-BLK-S`, `TEE-BLK-M`, …) into a search for one of its members,
  which is a different question from the one that was asked. The fold is `lower()` on both sides,
  as on the other two halves, and carries the same accepted non-ASCII caveat: SQLite's built-in
  `lower()` folds ASCII only where JS `toLowerCase()` is Unicode-aware. Skus are ASCII in
  practice, which is why this is accepted rather than solved. No escaping is involved on this
  half — an equality has no pattern language, so a sku spelled `50%_OFF` is compared character for
  character.
- **`EXISTS`, never a join — this is the correctness point, not a style note.** The list is one
  row per order and `order_items` is 1:N. Reaching the lines with a join would return an order
  once per matching line: a two-line order would appear twice in the page, the `limit + 1`
  next-page probe would count a duplicate as a row, the page would silently shrink, and
  `countOrders` — which shares the predicate — would over-count the very page it captions. Every
  adapter expresses the half as a correlated existence test and the fake as `lines.some(...)`; a
  contract case seeds an order whose lines BOTH match and pins that it comes back once, across a
  page boundary and in the count.
- **The two dialects plan it oppositely, and both shapes were measured rather than assumed.** On
  Postgres the intuitive reading is simply wrong: it does not run the correlated `EXISTS` per
  candidate order, it de-correlates it into a hashed subplan — one pass over `order_items` filtered
  on `lower(sku)`, hashed by `order_id` and probed in memory. `lower(sku)` has no index, so that
  pass is a sequential scan of the line table, and it happens whatever the operator typed: an id
  search pays for it too, and so does each of the two statements a searched page issues. Measured
  (statement `Execution Time`, synthetic 5k-order / 10k-line set): a SKU search 6.3 ms for the page
  and 5.9 ms for its count, against 2.8 ms and 2.8 ms with the arm stripped out; an id-prefix
  search 5.4 ms and 5.6 ms against 4.2 ms and 2.7 ms. Forcing the intuitive plan instead
  (`enable_seqscan = off`, which does turn the probe into a per-row index scan on
  `idx_order_items_order_product` over 5000 loops) was slower — 21–24 ms across runs — so that
  index is not what keeps this cheap on Postgres; the hash is. SQLite does the opposite and keeps
  the subquery correlated, serving it as a per-row index probe on that same index, and short-
  circuits the arm entirely for a row the two cheaper arms already matched (4.4 ms for an id page
  against 5.2 ms for a SKU page there). A functional index on `lower(order_items.sku)` is the
  obvious lever if the Postgres shape stops holding, and is deliberately not pulled now, on the
  same reasoning that declined a trigram index for the substring half: measure the real statement
  first.
- **The cursor gate is unaffected.** It compares the search STRING, not what the string selects,
  so the canonical form on the wire is identical before and after; a sku search pages and re-pages
  exactly like the other two, and a differently spelled one still fails closed.

No wire, schema or migration change.
