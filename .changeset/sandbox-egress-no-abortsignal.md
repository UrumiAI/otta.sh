---
"@otta-sh/payments-stripe": patch
"@otta-sh/payments-x402": patch
"@otta-sh/plugin": patch
---

Stripe calls and email sends now work when the plugin runs under EmDash's sandbox runner.
Both used to put `AbortSignal.timeout(...)` in `ctx.http.fetch`'s `init`. The runner sends
`init` to the host over Workers RPC, and workerd refuses to serialise an `AbortSignal`
(`DataCloneError: AbortSignal serialization is not enabled.`). So every Stripe call (intent,
customer, refund pre-flight and create, cancel and its follow-up read, the account-country
read) and every Resend or SMTP2GO send failed before anything was sent. Trusted (in-process)
deployments such as staging were not affected.

- **What changed.** No signal goes in `init` by default. Each call races its own deadline
  instead, and that race covers the request and the body read. A Stripe timeout classifies
  exactly as before: `retryable` on reads and on intent, customer and cancel creates,
  `ambiguous` on a refund create. An email timeout is still `EmailSendTimeoutError`. Idempotency
  keys are unchanged, and nothing is retried.
- **Bodies.** A body read that loses the race has its reader cancelled. An answer that arrives
  late is discarded with its body cancelled. A body nobody read is cancelled when the call ends.
  The x402 rail already sent no signal; it now also stops reading at its timeout.
- **New option: `trustedHost` (default `false`).** It is on `createStripeHttpTransport`,
  `StripePaymentGateway`, `fetchStripeAccountCountry` and the HTTP email senders. When set, a
  signal goes back in `init`, aborted at the same deadline, so a timed-out request's socket is
  released. Set it only on an in-process host; under the sandbox runner it fails every call.
  Nothing on `main` sets it yet. Until something does, a timed-out request on a trusted host
  keeps running in the background until the host's own limits end it, and its answer is
  discarded.
- **Type change for subclasses.** A subclass of the exported `CtxHttpEmailSender` that
  overrides the protected `checkResponse` now receives a `ProviderResponse` (`ok`, `status`,
  `text()`) instead of a `Response`.
