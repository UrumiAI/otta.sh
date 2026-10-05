---
"@otta-sh/plugin": minor
---

A store can send its email (sign-in links, order emails) through SMTP2GO as well as the
Resend-shaped sender. See DEPLOYMENT.md, "Email provider", and ADR-0005's 2026-10-05
amendment.

- **New Settings fields: "Email provider" and "SMTP2GO region".** They are in "Payments &
  email" and are saved with the other payment settings (`settings:emailProvider` is `resend`
  or `smtp2go`; `settings:emailSmtp2goRegion` is `global`, `us`, `eu` or `au`). The defaults
  are Resend and Global, so existing stores are unchanged. An unknown value is refused and
  nothing in that submit is saved.
- **The same "Email provider API key" field holds the SMTP2GO key.** With SMTP2GO chosen,
  the save expects a key starting `api-`. To switch, save the provider first, then the key.
- **`Smtp2goEmailSender`** posts to `https://<region host>/v3/email/send` with the key in
  `X-Smtp2go-Api-Key` and an `X-Otta-Id` header carrying the outbox row id. SMTP2GO can refuse
  a send with HTTP 200 (`data.failed > 0`); that counts as a failed send whose error carries
  SMTP2GO's reason, sanitized and bounded. SMTP2GO has no idempotency key, so a retried send
  can, rarely, be delivered twice.
- **allowedHosts gains four constant hosts:** `api.smtp2go.com`, `us-api.smtp2go.com`,
  `eu-api.smtp2go.com` and `au-api.smtp2go.com` (exported as `SMTP2GO_API_HOSTS`). SMTP2GO
  needs no `EMAIL_API_URL`: a build without one can send once SMTP2GO is chosen.
- **Shared sender base.** Rendering, the timeout and the sanitizing of provider errors moved
  to `HttpEmailSender`, which both senders extend. A provider refusal is now an
  `EmailProviderError` with a `kind`; the Resend sender's messages are unchanged.
