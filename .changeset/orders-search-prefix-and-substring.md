---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": patch
---

Orders search stops being exact-match only. `OrderListFilter.search` now matches an order-id
PREFIX or a `buyer_ref` SUBSTRING, ORed, with `lower()` on both sides of both halves. Every
exact lookup that worked before still RETURNS the same row — a whole id is its own prefix, a
whole address its own substring — but it no longer runs the same PLAN: the old exact pair was
served by an index and the new predicate scans (see below). Results preserved, cost changed.

`@otta-sh/service` is bumped because its `GET /admin/orders` answers differently for the same
query, though no service source changed — only its test coverage. `@otta-sh/plugin` is NOT
bumped: it forwards `search` verbatim and has no code, wire or copy change here.

- **A prefix, because a prefix is all the operator can see.** The console never renders a full
  uuid — it renders the shortest unique prefix (the git-style short id). Pasting the characters
  on screen back into the search box used to return nothing, which made the one identifier the
  list shows the one identifier it could not find. The id half stays ANCHORED: an unanchored
  match on a 32-character hex string surfaces arbitrary rows for any fragment.
- **A substring on the buyer reference, because that is the customer's email.** Operators arrive
  with a local part, a domain, or whatever the customer typed into a ticket, not the address
  exactly as stored.
- **The fold is explicit on both sides, in both dialects and in the fake.** A bare `LIKE` is
  case-sensitive on Postgres and ASCII-case-insensitive on SQLite — the two would have disagreed
  silently. `lower(col) LIKE lower(:pattern)` makes all three implementations agree for ASCII,
  and the contract suite pins every new case on the fake, SQLite and Postgres. The non-ASCII
  divergence is the repo's existing accepted position, inherited rather than introduced here:
  SQLite's built-in `lower()` folds ASCII only where JS `toLowerCase()` is Unicode-aware, so a
  buyer_ref like `JOSÉ@…` folds differently on sqlite than on pg and the fake — the same caveat
  `couponFilterConditions` and `linkGuestOrders` already carry. Emails and hex ids are ASCII,
  which is why it is accepted rather than solved. Ids are lowercase hex, so folding the id is a
  no-op on the stored side; it forgives the typed side.
- **`%`, `_` and `\` are characters, not wildcards.** The adapters escape the pattern and pass
  `ESCAPE '\'`; the fake builds no pattern at all. Searching `50%off` finds `50%off@…` and not
  `50xoff@…`, a bare `%` no longer means "every order", and the escape character itself is
  escaped first so it cannot re-escape the other two rules' output. The empty string, by the
  same logic, matches EVERYTHING — every string starts with and contains `""` — which is the
  inverted reading of "search for nothing" and is now pinned rather than left to be discovered.
  The service's query schema requires `min(1)`, so the wire cannot send it.
- **The sequential scan is the design.** An unanchored substring cannot be served by a b-tree, so
  this predicate no longer uses `idx_orders_buyer_ref_lower`, and the anchored id half cannot use
  the primary key under a default collation. A trigram or full-text index was declined at this
  scale, and the shape of the cost was measured first: over 5k rows a page whose search matches
  nothing (worst case — whole table scanned, then sorted) took 3.4 ms, and one dense enough for
  the keyset index to keep driving the ordering took under 1 ms. Those are a FLOOR, not the
  production statement — a synthetic four-column table, no `order_totals` join, and a real
  searched page pays the predicate twice (list plus count). The products list's ~27 ms figure is
  cited in the port only as the precedent for ACCEPTING an unanchored scan, never as a bound on
  this one; the two harnesses are not comparable. Recorded in the port where the old "deliberate
  divergence from products" note used to be.
- **The customer key did NOT follow.** `OrderCustomerKey.buyerRef` stays exact-lower-equals: it
  answers "whose orders are these", where a substring would fold two customers into one person's
  history, and equality is what keeps the functional index on the plan. `linkGuestOrders` is
  likewise untouched. The two predicates now differ on purpose, and a contract case pins the
  difference.
- **The cursor gate is unaffected.** It compares the search STRING, not what the string selects,
  so the canonical form on the wire is identical before and after. The admin Orders HTTP suite is
  unchanged apart from added cases.

No wire, schema or migration change, and no console copy change — the search label already named
both columns rather than promising exactness.
