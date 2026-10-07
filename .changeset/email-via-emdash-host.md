---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Email goes through the EmDash host's `ctx.email`; otta ships no email provider
([ADR-0031](../adr/0031-email-through-emdash-host.md)). Install and select an EmDash email
provider (for example `cloudflareEmail` with a `send_email` binding); the from-address, SPF,
DKIM and any key belong to it. The outbox and its at-least-once delivery are unchanged.

- **New capability `email:send`.** The plugin declares `content:read`, `network:request` and
  `email:send`. `allowedHosts` is now `api.stripe.com` plus the x402 facilitator when
  configured — no email host.
- **One sender.** `CtxEmailSender` renders as before (storefront money, the order link, the
  store name — "Store display name", else the EmDash site name) and calls `ctx.email.send`.
- **No provider fails closed and spends nothing.** Trusted: `ctx.email` is absent, the cron
  leg reports `skipped`, the console says "no email provider". Sandboxed: the host's "Email
  is not configured" answer becomes `EmailTransportUnavailableError` (new in
  `@otta-sh/domain`, with `isEmailTransportUnavailableError`); the dispatcher releases the row
  without counting an attempt, due again after `TRANSPORT_UNAVAILABLE_RETRY_MS` (5 min), and
  calls the new `onTransportUnavailable` option. The answer is recorded in kv
  (`state:emailTransportUnavailableAt`) for 5 minutes, during which the cron leg, the inline
  send and the sign-in request stop before claiming a row or minting a challenge.
- **A timeout counts as an attempt (behaviour change).** `ctx.email` has no idempotency key,
  so a send that timed out may have gone; counting it bounds duplicates by `maxAttempts` (5).
  Before, a Resend-path timeout was uncounted (up to ten, backed off), so a slow provider now
  parks a row `failed` sooner. The 3 s
  sign-in and inline ceilings and the 5 s sweep ceiling are unchanged.
- **Settings.** The email API key, SMTP2GO key, from-address, email provider and SMTP2GO
  region fields are removed. "Payments & email" shows one line: sent via EmDash's provider, or
  no provider (with a pointer to `docs/email-providers.md`).
- **Cron budget.** The `order-emails` leg's entry cost is one kv read (was up to three), and
  one email unit is 12 calls (was 14), so the Workers Paid email batch is 15 (was 12).

**Breaking (`@otta-sh/plugin`), removed from the package root:** `CtxHttpEmailSender`,
`CtxHttpEmailSenderOptions`, `EmailSenderEgress`, `DEFAULT_EMAIL_FROM`, `EMAIL_FROM_KEY`,
`Smtp2goEmailSender`, `Smtp2goEmailSenderOptions`, `EmailProviderError`,
`EmailProviderErrorKind`, `DEFAULT_EMAIL_PROVIDER`, `DEFAULT_SMTP2GO_REGION`,
`EMAIL_PROVIDER_KEY`, `EMAIL_PROVIDERS`, `EmailProviderId`, `SMTP2GO_REGION_KEY`,
`SMTP2GO_REGIONS`, `Smtp2goRegion`, `SMTP2GO_API_HOSTS`, `EMAIL_API_KEY_KEY`,
`emailApiKeyFromKv`. `PaymentSecrets` loses `emailApiKey`; `PAYMENT_SECRET_KEYS` loses the two
email keys; `InProcessEgressUrls` loses `emailApiUrl`; the `__OTTA_EMAIL_API_URL__` build
define is gone. `makeEmailSender(ctx, options?)` no longer takes an egress argument and returns
`undefined` when the host has no email provider. New: `CtxEmailSender`, `CtxEmailSenderOptions`.
`PluginContext` gains optional `email` and `site`.

This supersedes the email-transport parts of earlier unreleased entries (the Resend-shaped
and SMTP2GO senders, their keys and hosts, and the from-address setting).

**On upgrade:** a store that sent through a build-time email URL or SMTP2GO goes quiet until
an EmDash email provider is selected; its emails wait in the outbox and go out then.
