---
"@otta-sh/plugin": minor
---

Implement `InProcessCommerceClient` — the storefront `CommerceClient` surface with
commerce truth on the plugin's own document store, no commerce service and no
egress (ADR-0018).

- All 25 port methods are the domain's use-cases composed over the
  `@otta-sh/store-emdash` adapters: explicit idempotency keys, money as integer
  minor units with its currency, and the two pieces of behaviour that were never
  just a use-case call — the add's sku guard (every add must resolve its sku to a
  live, priced sellable unit of the named product) and the quote's per-line price
  resolution in one store round trip — mirrored with their reasoning.
- One composition function builds every store once over `ctx.storage`, sharing a
  clock and an id source, wiring inventory into the cart and order stores and the
  reporting writer into the order store so rollups accrue from the first order.
- Identity is the session's and only the session's: no method accepts a customer
  id, and a foreign or unknown order is `NOT_FOUND` rather than a refusal.
- Typed refusals the port declares are values; everything else rejects with its
  own structural `code` — no status codes exist here to translate, and a
  contention abort stays retryable.
- `PluginContext` gains `storage`, typed as the adapters' own structural
  `StorageAccess` (type-only). No new capability: the host builds the store on an
  always-available path and there is no capability string for it.
- The client contract's storefront slice now runs on BOTH transports from the same
  cases — the in-process tier over a real per-collection repository on SQLite, the
  HTTP tier over a live service — and the workerd suites carry a real
  `ctx.storage`, with a new suite driving a commerce write, read and join read
  from inside the isolate.
