---
"@otta-sh/plugin": patch
---

The commerce sweep never expires an order whose payment intent is still payable, and never
sends an email or withdraws an intent twice because the tick's query ceiling fell part-way
through the unit (QA3 N1, N2).

- `cancel-intents` withdraws every due intent it lists. It no longer skips the orders this
  tick's expiry is about to flip.
- `expire-orders` skips an order whose intent is due and not yet withdrawn.
- Before a send or a cancel, the outbox and `cancel-intents` check that the rest of the unit,
  including its record, fits.
- Once the provider call has returned, its record runs in a small commit window that the
  ceiling does not refuse. The tick's log line reports any calls past the ceiling.
- The email unit estimate is 12 (was 8), and the Paid email batch is 15 (was 22).
- The test-only `emailSenderFactory` option also receives the counted context.
