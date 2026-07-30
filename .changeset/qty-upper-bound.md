---
"@otta-sh/service": minor
---

Wire-level upper bounds on the three unbounded `qty` sites (service-hardening plan §4):
`POST /carts/:cartId/lines`, `PATCH /carts/:cartId/lines/:lineId`, and
`POST /inventory/reserve`. Today `qty: 1e9` (or `Number.MAX_SAFE_INTEGER`) is a "valid" wire
request — only the store's arithmetic ever rejects it — so an absurd value reaches the store
before anything says no. A zod `.max()` makes "how much may one request ask for" an explicit,
documented, tested part of the contract instead of an accident of IEEE-754, and rejects it
early and cheaply (400 at the schema boundary, before any store call and before any row is
written).

At `0.x`, changesets map a **minor** bump to a breaking change (there is no major to take yet —
semver's `0.x` carve-out). The `minor` here IS the breaking bump, not a feature bump.

**BREAKING (wire-visible):** previously-accepted requests now fail — `qty > 10_000`
(`CART_LINE_MAX_QTY`, new exported constant) on `POST /carts/:cartId/lines` and
`PATCH /carts/:cartId/lines/:lineId`, and `qty > 1_000_000_000` (`RESERVE_MAX_QTY`, new
exported constant, aligned with the existing admin `stockMovementBody` cap) on
`POST /inventory/reserve`, now return **400** `{error: "invalid request body", issues: [...]}`
where they were previously accepted and processed. Both caps are two different numbers,
deliberately: cart lines are the shopper-facing, anonymous-internet-caller surface (10k is
already absurd for a storefront line); `/inventory/reserve` is the raw inventory primitive (a
machine caller), whose natural peer is the admin stock-movement cap. Both are wire-only
(zod, `schemas.ts`) — the domain already enforces the positive-integer bound
(`domain/src/inventory/use-cases.ts`) as defense-in-depth; no domain or port change.

**Scope — read before assuming this closes the abuse surface:** this cap does **not** stop
junk-`failed`-reservation-row amplification or general write amplification on
`POST /inventory/reserve` / `POST /carts/:id/lines`. That is bound by **request count**, not
qty magnitude — a caller sending 10,000 requests at `qty: 9,999` (comfortably under either cap)
mints exactly as many junk rows as one request at `qty: 1e9` did before this change. The real
mitigation is rate limiting / abuse control on these two unauthenticated write endpoints, which
this repo does not have. Follow-up filed and tracked at
[UrumiAI/otta.sh#91](https://github.com/UrumiAI/otta.sh/issues/91) — do not read this PR as a
DoS fix.
