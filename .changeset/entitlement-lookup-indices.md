---
"@otta-sh/store-postgres": patch
---

Index the entitlement check. `KyselyEntitlementStore#check` — the delivery gate
that decides whether a customer may access what they bought — filters on
`state`, `sku`, and at least one of `order_id` or a case-folded `buyer_ref`,
against a table that carried only its primary key and the UNIQUE on
`grant_idempotency_key`. Every axis of that predicate was a sequential scan.

Migration `0024` adds two composite b-trees, each led by one of the two scope
axes so the check is a point lookup on either path: `(lower(buyer_ref), sku,
state)` — functional, matching the fold the predicate already uses — and
`(order_id, sku, state)`. `sku` does not lead either: it is the one axis whose
matching set grows with a product's popularity rather than with a single order
or buyer. `state` is carried as an ordinary column rather than as a partial
`WHERE state = 'active'` predicate, because the store binds the state as a
parameter and Postgres can only prove a partial predicate from a parameter under
a custom plan — a partial index would silently fall back to a sequential scan
under a generic one.

The write path pays two extra b-tree entries and one `lower()` evaluation per
row inserted. `grant` is the table's only writer and runs once per paid digital
line, so that cost lands on a path that already writes a row and never on the
check.

Both indices apply on SQLite and Postgres with no dialect fork, and an EXPLAIN
test pins each plan against the SQL the store itself compiles, so a rewritten
fold fails loudly instead of quietly losing the index. Forward-only and additive
— no port, wire-format, or return-shape change.
