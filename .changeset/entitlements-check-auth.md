---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
"@otta-sh/plugin": minor
---

Authenticate `GET /entitlements/check` — close the unauthenticated email existence oracle (#33, ADR-0011).

- `@otta-sh/domain`: **contract tightening.** `EntitlementStore.check` now requires
  CASE-INSENSITIVE `buyerRef` matching (email semantics), enforced by the shared contract suite
  that every downstream adapter must pass — hence a minor.
- `@otta-sh/store-postgres`: **matching-semantics change** (precedent: `checkout-address-capture.md`).
  The Kysely adapter folds case (`lower(buyer_ref) = lower(?)`) to conform to the tightened
  contract — a `check` call that previously returned `false` for a case-differing `buyerRef` can
  now return `true`, hence a minor rather than a patch.
- `@otta-sh/service`: **WIRE BREAK.** `GET /entitlements/check` is no longer an anonymous oracle
  over email. Presence-based scope precedence: a query containing `buyerRef` now requires
  `X-Internal-Token` (**401** on mismatch, **503** when unconfigured — never silently open); a
  sku-only request requires a customer session (`Authorization: Bearer`); the `orderId` scope is
  unchanged (open bearer capability). Callers probing by email must now send `X-Internal-Token`.
- `@otta-sh/plugin`: **WIRE BREAK.** The `entitlements/download` route input drops `buyerRef` in
  favor of `sessionToken`; `HttpCommerceClient.checkEntitlement` gains an optional `sessionToken`
  and now returns a typed `{ ok: false, reason: "UNAUTHENTICATED" }` on 401 instead of a boolean.
