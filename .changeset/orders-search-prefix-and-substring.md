---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
---

Orders search stops being exact-match only. `OrderListFilter.search` now matches an order-id
PREFIX or a `buyer_ref` SUBSTRING, ORed, with `lower()` on both sides of both halves. Exact
lookups are unaffected: a whole id is its own prefix and a whole address is its own substring,
so every search that worked before still returns the same row.

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
  silently. `lower(col) LIKE lower(:pattern)` makes all three implementations agree case for
  case, and the contract suite pins every new case on the fake, SQLite and Postgres. Ids are
  lowercase hex, so folding the id is a no-op on the stored side; it forgives the typed side.
- **`%` and `_` are characters, not wildcards.** The adapters escape the pattern and pass
  `ESCAPE '\'`; the fake builds no pattern at all. Searching `50%off` finds `50%off@…` and not
  `50xoff@…`, and a bare `%` no longer means "every order".
- **The sequential scan is the design.** An unanchored substring cannot be served by a b-tree, so
  this predicate no longer uses `idx_orders_buyer_ref_lower`, and the anchored id half cannot use
  the primary key under a default collation. A trigram or full-text index was declined at this
  scale — the products list already runs an unanchored substring at roughly 27 ms per page over
  5k rows, and an index here buys operational surface rather than latency. Recorded in the port
  where the old "deliberate divergence from products" note used to be.
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
