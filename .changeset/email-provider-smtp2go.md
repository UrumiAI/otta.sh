---
"@otta-sh/plugin": minor
---

A store can send its email (sign-in links, order emails) through SMTP2GO as well as the
Resend-shaped sender. See DEPLOYMENT.md, "Email provider", and ADR-0005's 2026-10-05
amendment.

- **New Settings fields: "Email provider", "SMTP2GO region" and "SMTP2GO API key (email)".**
  In "Payments & email". The provider and region are saved with the other payment settings
  (`settings:emailProvider` is `resend` or `smtp2go`; `settings:emailSmtp2goRegion` is
  `global`, `us`, `eu` or `au`); an unknown value is refused and nothing in that submit is
  saved. The defaults are Resend and Global, so existing stores are unchanged.
- **One key slot per provider.** The SMTP2GO key has its own write-only slot,
  `settings:emailSmtp2goApiKey` (shape `api-…`), with its own Remove button; Resend keeps
  `settings:emailApiKey`, whose field is now labelled "Resend API key (email)". A key is only
  ever sent to its own provider. SMTP2GO chosen without its key, or a provider choice that
  cannot be read, is unconfigured: nothing is claimed or sent.
- **`Smtp2goEmailSender`** posts to `https://<region host>/v3/email/send` with the key in
  `X-Smtp2go-Api-Key`. SMTP2GO can refuse a send with HTTP 200 (`data.failed > 0`); that
  counts as a failed send whose error carries SMTP2GO's reason and `request_id`, sanitized and
  bounded. SMTP2GO has no idempotency key, so a timeout on it counts as an attempt: duplicates
  are bounded by the row's `maxAttempts`.
- **allowedHosts gains four constant hosts:** `api.smtp2go.com`, `us-api.smtp2go.com`,
  `eu-api.smtp2go.com` and `au-api.smtp2go.com` (exported as `SMTP2GO_API_HOSTS`). SMTP2GO
  needs no `EMAIL_API_URL`.
- **Shared sender base.** Rendering, the timeout and the sanitizing of provider errors moved
  to `HttpEmailSender`, which both senders extend. Provider error text now also has bidi
  controls replaced, and bodies up to 64 KiB are parsed (the detail is still cut to 200
  characters). A refusal is an `EmailProviderError` with a `kind`; the Resend sender's
  messages are unchanged.
- **The cron sweep's email budget counts the real cost:** the provider is resolved once per
  tick (the leg's entry cost), and the email unit includes the sender's kv reads, so the
  Workers Paid preset's email batch is 12 (was 15). The resolve runs inside the leg's budget
  and only when an email is due: a tick too busy for it defers the leg, which keeps aging,
  and an idle outbox costs only its due check.
