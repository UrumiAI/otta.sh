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
- Input is refused at the boundary, before any store call: the bounds the request
  schemas used to enforce are mirrored in one plugin-local module (copied, never
  imported — the service goes away), and a bad input rejects with a structural
  `INVALID_INPUT` code carrying the field and the reason. The watermark format is the
  load-bearing one: it is compared as raw text, so one garbage high-sorting value
  accepted once would wedge every later sync.
- `PluginContext` gains an OPTIONAL `storage`, typed as the adapters' own structural
  `StorageAccess` (type-only). Optional because the HTTP transport never reads it and
  the unit suites that hand-build a context have none to offer; the in-process
  composition demands it by name and fails loudly without it. No new capability: the
  host builds the store on an always-available path and there is no capability string
  for it.
- Two gaps are deliberate and each is pinned by a test: `createOrder` composes an
  empty gateway map (every payment method fails loudly rather than minting an
  unpayable order), and `requestLoginLink` records the challenge but dispatches no
  mail. Both close with the payments and mail changes.
- Declaration emit for this package now runs in TypeScript project mode, which is
  what a value-level import of a workspace source package requires; the packaging
  guard builds what the package's own build builds, declarations included.
- The client contract's storefront slice now runs on BOTH transports from the same
  cases — the in-process tier over a real per-collection repository on SQLite, the
  HTTP tier over a live service — and the workerd suites carry a real
  `ctx.storage`, with a new suite driving a commerce write, read and join read
  from inside the isolate.
