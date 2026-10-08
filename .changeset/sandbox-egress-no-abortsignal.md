---
"@otta-sh/payments-stripe": patch
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
- **Interim cost on trusted hosts.** Nothing sets `trustedHost` yet, so on an in-process host
  (staging) a timed-out request is no longer cancelled at the socket. Results do not change:
  the call still gives up at the same bound with the same class, and its late answer is
  discarded. Resources do:
  - on Node, the socket stays open until undici's own 300 s header and body timeouts;
  - on Workers, the connection stays open until the request (or cron invocation) ends, and it
    uses one of the 6 simultaneous connections a Workers invocation may hold. So a hung Stripe
    during one cron tick can make the other sends and refunds in that tick queue and time out.
    That costs availability, not money: a refund create that times out is `ambiguous` and
    keyed, a Resend send is keyed, an SMTP2GO send is a counted attempt, and each is retried on
    a later tick.

  The fix is to have the site's composition root set the flag
  (`createOttaPlugin({ trustedHost })`, which is coming with the tax work). That restores
  cancellation at the socket on trusted hosts.
- **Email error bodies are capped.** A Resend or SMTP2GO non-2xx body is now read only as far
  as 16 KiB and then cancelled. Before, it was read whole until the deadline. A provider's
  refusal is far smaller than that, so its reason still reaches the log.
- **Type change for subclasses.** A subclass of the exported `CtxHttpEmailSender` that
  overrides the protected `checkResponse` now receives a `ProviderResponse` (`ok`, `status`,
  `text()`) instead of a `Response`. An override still typed `(res: Response)` **still
  compiles**, because TypeScript checks method parameters bivariantly. It then fails at
  runtime if it calls `res.json()` or reads `res.headers` or `res.body`. Read the body with
  `res.text()` instead.
