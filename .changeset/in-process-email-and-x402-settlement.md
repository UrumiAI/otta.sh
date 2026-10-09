---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Dispatch order emails from inside the plugin (work order 02, INC-C5). Only the
TRANSPORT moves: the `EmailSender` port, the rendered wire bodies and the
`Idempotency-Key` dedupe hinge are all unchanged.

- `@otta-sh/domain`: `renderEmail` / `customerSafeCancellationCopy` now live
  here, beside `buildOrderEmailData` and the `EmailTemplate` union. They are
  pure functions of a template plus explicit data — no IO, no store reach-back —
  so the purity contract is unchanged; the domain is the one place every
  `EmailSender` adapter can reach them from. Money still renders from integer minor
  units, and now renders a NEGATIVE amount correctly (`-550` was "-6.-50") and a
  non-integer not at all. `PaymentEventStore` also grows
  `orderForDedupeKey(key)`: `dedupe`'s boolean says a row EXISTS, not whose it
  is, and `settleOrder` discarded it entirely. It now asks — only on the
  duplicate path, so first deliveries still cost one statement — and terminally
  refuses a confirmation whose key is recorded against a DIFFERENT order with
  the new `RECEIPT_REBOUND` failure plus an anomaly of the same name. A
  redelivery to the SAME order still re-drives as before.
- `@otta-sh/plugin`: adds an in-process order-email sender (`makeEmailSender`,
  timeout-bounded; email goes through the host's `ctx.email`, ADR-0031).
  `IN_PROCESS_EGRESS_URLS` is resolved through the same gate the allowlist uses, so
  a consumer can no longer egress to a host `allowedHosts` refuses. The cron
  sweep's `order-emails` leg builds its own sender (the injected one becomes an
  override) and reports `skipped` when no email provider is configured. Every
  missing-config path yields no sender rather than a guess.
