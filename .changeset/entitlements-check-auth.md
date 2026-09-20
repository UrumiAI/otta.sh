---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Authenticate the entitlement check — close the unauthenticated email existence oracle (#33, ADR-0011).

- `@otta-sh/domain`: **contract tightening.** `EntitlementStore.check` now requires
  CASE-INSENSITIVE `buyerRef` matching (email semantics), enforced by the shared contract suite
  that every downstream adapter must pass — hence a minor.
- `@otta-sh/plugin`: **WIRE BREAK.** Checking an entitlement by buyer email is no longer an
  anonymous probe: the `entitlements/download` route input drops `buyerRef` in favor of
  `sessionToken`, and the commerce client's `checkEntitlement` takes an optional `sessionToken`
  and now returns a typed `{ ok: false, reason: "UNAUTHENTICATED" }` instead of a bare boolean,
  so "could not ask" is distinguishable from "not entitled". The `orderId` scope is unchanged —
  it stays an open capability read.
