---
"@urumi/domain": minor
"@urumi/store-postgres": minor
"@urumi/service": minor
"@urumi/plugin": minor
---

Merchant restock path for inventory (admin-UX Increment 2, slice 3): an admin can add stock
to an existing sku, and remove damaged/shrinkage units — WITHOUT ever violating the headline
no-oversell invariant under concurrency.

The gap this closes: `InventoryStore.seedOnHand` is create-only and `adjust` is
reservation-scoped, so a merchant had no safe path to change a live sku's raw on-hand count.

- **Domain (`[Domain]`).** Two new `InventoryStore` port methods + pure use-cases: `restock`
  (add units) and `removeStock` (remove units). A restock is a single UNCONDITIONAL `on_hand +
  qty` — commutative with every concurrent guarded decrement (`reserve`/`removeStock`), so it
  can never cause an oversell (no guard needed; adding only ever raises availability). A
  removal is a single GUARDED `on_hand - qty WHERE on_hand >= qty` — the same guard shape as
  `reserve`'s decrement, so it can never drive on-hand below 0 or race a reservation into
  oversell; the loser gets a clean `INSUFFICIENT_STOCK`. Both are exactly-once, ledger-first
  (a new per-mutation `inventory_stock_movements` ledger, mirroring `adjust`'s claim
  discipline): a replay moves nothing, and a key reused for a different (sku, direction, qty)
  is a typed `StockMovementMismatchError`. An unknown sku is a clean `UNKNOWN_SKU` that does
  NOT consume the key (mirrors `reserve`'s parity) and never auto-creates the row —
  `seedOnHand` stays the sole create path.
- **Adapters (`[Adapters]`).** Kysely implementation (sqlite + pg) with the atomic movement as
  a single guarded UPDATE inside the claim transaction (no read-modify-write). Forward-only
  migration `0016_inventory_stock_movements`. The Postgres no-oversell races are green
  (restock +N racing M reservations; N guarded removals racing M reservations; concurrent
  same-key restock/removal replays applied exactly once).
- **Service (`[Service]`).** `POST /admin/products/:id/restock` and `.../remove-stock` under
  the `X-Service-Token` write gate + internal token, resolving the productId to its
  authoritative sku (never trusting a client-supplied one). A restock is additive (not
  idempotent by nature), so the `Idempotency-Key` header is REQUIRED — there is no safe
  content-only fallback.
- **Plugin (`[Plugin]`).** Restock + remove-stock forms on the product detail (integer-only
  qty inputs — same integer discipline as money, never a float widget; clear copy showing
  current available and danger copy on removal). Each carries a per-render nonce so a
  double-submit dedupes while two deliberate movements each apply.

Not in scope (follow-ups): stock-movement history/audit table, reorder points, multi-location.
