---
"@otta-sh/domain": minor
"@otta-sh/payments-x402": minor
"@otta-sh/plugin": minor
---

Dispatch order emails and settle x402 payments from inside the plugin, over
`ctx.http` (work order 02, INC-C5). Only the TRANSPORT moves: the `EmailSender`
and `X402Facilitator` ports, the rendered wire bodies, the `Idempotency-Key`
dedupe hinge and `refundable = false` (ADR-0008) are all unchanged.

- `@otta-sh/domain`: `renderEmail` / `customerSafeCancellationCopy` move here
  verbatim from `@otta-sh/service`, beside `buildOrderEmailData` and the
  `EmailTemplate` union. They are pure functions of a template plus explicit
  data — no IO, no store reach-back — so the purity contract is unchanged; they
  had to move because BOTH `EmailSender` adapters now need them and they live in
  packages that cannot import each other. Money still renders from integer minor
  units, and now renders a NEGATIVE amount correctly (`-550` was "-6.-50") and a
  non-integer not at all. `PaymentEventStore` also grows
  `orderForDedupeKey(key)`: `dedupe`'s boolean says a row EXISTS, not whose it
  is, and `settleOrder` discarded it entirely. It now asks — only on the
  duplicate path, so first deliveries still cost one statement — and terminally
  refuses a confirmation whose key is recorded against a DIFFERENT order with
  the new `RECEIPT_REBOUND` failure plus an anomaly of the same name. A
  redelivery to the SAME order still re-drives as before.
- `@otta-sh/payments-x402`: adds `createHttpFacilitator`, a real facilitator call
  over an INJECTED `fetch` (so the sandboxed plugin can hand it `ctx.http.fetch`
  and the package keeps its no-ambient-fetch guarantee), bounded by
  `AbortSignal.timeout` (`DEFAULT_FACILITATOR_TIMEOUT_MS`). Fail-closed in every
  direction: nothing short of an explicit `valid: true` ABOUT THIS RECEIPT — a
  facilitator that echoes a `transaction`/`orderId` must echo the one asked
  about — settles. "Not valid" is reported as TWO facts, not one: a verdict on
  the buyer's proof stays terminal, while "the facilitator could not be asked"
  (transport failure, timeout, 5xx/429/401/403, unparseable body) carries
  `unavailable: true` on the new `X402VerifyResult` and surfaces from
  `verifyConfirmation` as a retryable `X402FacilitatorUnavailableError`, so a
  five-second blip cannot become a permanent refusal for a buyer whose USDC has
  already moved.
- `@otta-sh/plugin`: adds `CtxHttpEmailSender` (+ `makeEmailSender`, likewise
  timeout-bounded) and the x402 wiring (`wireX402Gateway` /
  `x402GatewayFromCtx`), both reaching their provider only via `ctx.http` +
  `allowedHosts`. Adds the PUBLIC `entitlements/x402/settle` route — the
  in-process equivalent of the service's `POST /entitlements/grant`, behind the
  SAME two layers the Stripe webhook route uses — the shared edge token
  (`settings:edgeToken`, pass-through when unset) as a cheap outer gate, then
  the real check: the order must be `paymentMethod: "x402"`, the proof must
  verify through the configured facilitator, and the on-chain `transaction` must
  not already be bound to a different order. Answers
  200 / 400 / 401 / 404 / 503 with no order body (ADR-0010). Adds the Settings fields
  for the three non-secret keys (`settings:emailFrom`, `settings:x402PayTo`,
  `settings:x402Accepts`), with `payTo` shape-gated at BOTH ends
  (`isPlausiblePayTo` on read, an atomic refusal on write) because that kv tier
  has no CAS and the value is where the buyer's money goes. `IN_PROCESS_EGRESS_URLS`
  is now resolved through the same commerce-mode gate the allowlist uses, so a
  consumer can no longer egress to a host `allowedHosts` refuses. The cron
  sweep's `order-emails` leg builds its own sender (the injected one becomes an
  override) and reports `skipped` when no email URL was baked in. Secrets stay in
  write-only kv; every kv read is fail-soft and every missing-config path yields
  no sender / no gateway rather than an unverified settlement.
- `@otta-sh/service`: imports `renderEmail` from the domain instead of its own
  deleted copy. No behavior change. NOTE that the service is untouched
  otherwise: it still wires only the offline `createTestFacilitator` behind
  `X402_ALLOW_TEST_FACILITATOR`, and that gate still guards exactly what it
  always did for as long as the service runs — the in-process path simply cannot
  reach that facilitator.

ACTION REQUIRED ON UPGRADE — RE-PROVISION THE x402 FACILITATOR CREDENTIAL. The
kv key is now `settings:x402FacilitatorApiKey`; the old
`settings:x402FacilitatorSecret` is no longer read and is deleted the next time
the field is saved. This is deliberate and not a rename for tidiness: under the
previous increment that key named a value used to VERIFY an inbound signature,
and this increment puts the configured value ON THE WIRE as
`Authorization: Bearer` to the facilitator. A secret provisioned under the old
meaning must never be sent outbound, so it is orphaned rather than migrated.
Until the new key is set, the settle route answers `NOT_CONFIGURED` (503) —
fail-closed, never an unverified settlement.

NOTE ON THE x402 HALF. It is configurable and settleable in-process now, but a
buyer still cannot ORIGINATE an x402 checkout from the storefront: the
plugin's checkout route hardcodes `PAYMENT_METHOD = "stripe"`. So today no
first-party flow creates an x402 order at all — but the settle route does NOT
rely on that for its safety: it refuses a non-x402 order explicitly
(`WRONG_PAYMENT_METHOD`), and the domain refuses a receipt whose dedupe key is
already bound to another order (`RECEIPT_REBOUND`, a recorded anomaly), so one
on-chain payment can settle exactly one order.

FOLLOW-UP: make the storefront checkout method selectable (the one remaining
piece of the x402 path), and decide whether a facilitator that cannot attest the
settlement's recipient is enough for production (the adapter's
swap-in requirements, unchanged by this increment).
