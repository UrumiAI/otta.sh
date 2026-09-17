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
  packages that cannot import each other. Money still renders from the branded
  integer minor units it is handed.
- `@otta-sh/payments-x402`: adds `createHttpFacilitator`, a real facilitator call
  over an INJECTED `fetch` (so the sandboxed plugin can hand it `ctx.http.fetch`
  and the package keeps its no-ambient-fetch guarantee). Fail-closed in every
  direction — transport rejection, non-2xx, unparseable body, or anything short
  of an explicit `valid: true` is `{ valid: false }`, never a throw, because
  `verifyReceipt` sits directly in front of `settleOrder`. The offline
  shared-secret `createTestFacilitator` is untouched and simply unreachable from
  the in-process path, so the service's `X402_ALLOW_TEST_FACILITATOR` opt-in has
  nothing left to guard.
- `@otta-sh/plugin`: adds `CtxHttpEmailSender` (+ `makeEmailSender`) and the x402
  wiring (`wireX402Gateway` / `x402GatewayFromCtx`), both reaching their provider
  only via `ctx.http` + `allowedHosts` — the hosts INC-C3 already derives from
  `IN_PROCESS_EGRESS_URLS`, so the allowlist is unchanged. The cron sweep's
  `order-emails` leg now builds its own sender (the injected one becomes an
  override) and reports `skipped` when no email URL was baked in;
  `InProcessCommerceClient` accepts gateways, which `makeCommerceClientFor`
  resolves. Secrets stay in write-only kv; the non-secret companions
  (`settings:emailFrom`, `settings:x402PayTo`, `settings:x402Accepts`) are
  readable kv. Every kv read is fail-soft and every missing-config path yields no
  sender / no gateway rather than an unverified settlement.
- `@otta-sh/service`: imports `renderEmail` from the domain instead of its own
  deleted copy. No behavior change.

FOLLOW-UP: the three non-secret settings keys have no admin settings-form fields
yet (they are documented, exported kv keys); and the service's
`POST /entitlements/grant` x402 settle surface has no in-process route
equivalent — adding one is a `CommerceClient` port change, tracked separately.
