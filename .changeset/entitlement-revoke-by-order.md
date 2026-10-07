---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
---

**BREAKING for out-of-tree `EntitlementStore` implementations:** the port gains a
required method, `revokeByOrder(orderId)`. It flips every `active` entitlement the order
granted to `revoked` and returns how many THIS call flipped (`0` on a replay). Afterwards
`check` answers false for every scope those grants satisfied, unless another order's
active grant covers it. Revocation is terminal: a replayed `grant` under the same key
returns the revoked grant and never re-activates it.

`EmdashEntitlementStore` implements it as one compare-and-set per grant over the declared
`orderId` index, guarded on `active`, so concurrent revokes flip each grant exactly once.
The contract suite gains the revoke cases (every grant of the order, both scopes;
idempotent replay; other orders untouched; no resurrection by a replayed grant), run on
the fake, SQLite, Postgres and D1, plus a Postgres race of concurrent revokes.

**BREAKING for users of `@otta-sh/domain/testing`:**

- `EntitlementStoreHarness` loses its `revoke(orderId)` hook. A harness now supplies only
  `{ store }`, and the contract revokes through the port.
- `InMemoryEntitlementStore.revokeByOrder` is now the port method. It was a synchronous
  test helper returning nothing; it is now `async` and resolves to the number of grants
  it flipped. A caller that used it synchronously must `await` it.

Part of #376 (download delivery).
