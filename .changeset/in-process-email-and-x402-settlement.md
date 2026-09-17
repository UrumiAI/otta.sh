---
"@otta-sh/domain": minor
"@otta-sh/payments-x402": minor
"@otta-sh/plugin": minor
"@otta-sh/service": patch
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
  non-integer not at all.
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
  in-process equivalent of the service's `POST /entitlements/grant`, verifying
  the proof through the configured facilitator unconditionally and answering
  200 / 400 / 404 / 503 with no order body (ADR-0010). Adds the Settings fields
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

NOTE ON THE x402 HALF. It is configurable and settleable in-process now, but a
buyer still cannot ORIGINATE an x402 checkout from the storefront: the
plugin's checkout route hardcodes `PAYMENT_METHOD = "stripe"`. Until that
becomes a selectable method, `entitlements/x402/settle` is reachable only for
orders created with `paymentMethod: "x402"` by some other caller.

FOLLOW-UP: make the storefront checkout method selectable (the one remaining
piece of the x402 path), and decide whether a facilitator that cannot attest the
settlement's recipient is enough for production (the adapter's
swap-in requirements, unchanged by this increment).
