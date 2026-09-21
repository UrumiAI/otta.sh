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
- `PluginContext` gains an OPTIONAL `storage`, typed against a structural mirror
  declared in the plugin itself — NOT the adapter package's type, which names the
  host's, because the context's shape is public API and the emitted declarations must
  not make a consumer resolve a package this one does not depend on. The mirror is
  drift-checked at the composition root (both directions), the published types name no
  host package, and a test asserts that of every emitted declaration. Optional because
  the unit suites that hand-build a context have none to offer; the in-process composition
  demands it by name and fails loudly without it. No new capability: the host builds the store on an always-available path and
  there is no capability string for it. Declaration emit for the package now runs in
  TypeScript project mode, which is what a value-level import of a workspace source
  package requires.
- Three gaps are deliberate, and the first two are each pinned by a test:
  `createOrder` composes an empty gateway map (every payment method fails loudly
  rather than minting an unpayable order, and a held cart survives the refusal
  intact); `requestLoginLink` records the challenge but dispatches no mail; and the
  cart-hold and checkout TTLs fall back to the domain's defaults, so a deployment
  that had moved its hold window gets fifteen minutes back in-process until the
  settings and sweep wiring reads the value it already stores. The first two close
  with the payments and mail changes; the third must close before a deployment flips.
- The packaging guard builds what the package's own build builds, declarations
  included — it had been skipping them, which is why it stayed green against a build
  that could not run at all.
- The client contract's storefront slice now runs against the in-process tier over a
  real per-collection repository on SQLite, and the workerd suites carry a real
  `ctx.storage`, with a new suite driving a commerce write, read and join read
  from inside the isolate.
