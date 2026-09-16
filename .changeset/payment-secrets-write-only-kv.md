---
"@otta-sh/plugin": minor
---

Provision the payment/email credentials in write-only plugin kv, and widen the egress
allowlist per commerce mode (work order 02, INC-C3).

Folding `@otta-sh/service` into the plugin moves the calls the service used to make —
Stripe's API, the email provider, the x402 facilitator — to the plugin itself. Those calls
need two things the plugin did not have: the credentials, and permission to reach the hosts.

- **Secrets (`payment-secrets.ts`).** Four write-only kv keys, following the existing
  `settings:serviceToken` pattern exactly (ADR-0007): `settings:stripeSecretKey`,
  `settings:stripeWebhookSecret`, `settings:emailApiKey` and `settings:x402FacilitatorSecret`
  — the plugin-side homes of the service's `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `EMAIL_API_KEY` and `X402_FACILITATOR_SECRET`. Each has a fail-closed reader: a kv read that
  rejects degrades to `undefined` (never throws, never substitutes an empty value that could
  read as "configured"), and one failing read cannot disarm the other three. Values are never
  baked into the bundle and never rendered back into a block — the Settings page grows a
  "Payments & email" group whose fields are plain always-empty text inputs, a blank submit
  keeps the current value, and only a derived boolean ("configured" / which ones are missing)
  ever reaches a label.
- **Egress (`resolveAllowedHosts`).** `allowedHosts` is now resolved per mode from one pure
  function shared by the bundle's `ALLOWED_HOSTS` and the site descriptor, so the two cannot
  drift. `"http"` (still the default, and byte-identical to what shipped before) is exactly
  the commerce service's host. `"in-process"` is exactly `api.stripe.com` plus whichever of the
  email/facilitator hosts the deployment supplied via the new `__OTTA_EMAIL_API_URL__` /
  `__OTTA_X402_FACILITATOR_URL__` build defines — the service host disappears, and an absent or
  unparseable URL grants no host rather than guessing one.

New exports: `PAYMENT_SECRET_KEYS` and the per-secret key constants and readers,
`resolveAllowedHosts`, `STRIPE_API_HOST`, `IN_PROCESS_EGRESS_URLS`, `InProcessEgressUrls`,
and `CommerceMode` / `resolveCommerceMode` re-exported from the package root.
