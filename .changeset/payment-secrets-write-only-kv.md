---
"@otta-sh/plugin": minor
---

Provision the payment/email credentials in write-only plugin kv, and widen the egress
allowlist to the hosts that now need reaching (work order 02, INC-C3).

Running commerce inside the plugin moves the outbound calls that used to be made
server-side — Stripe's API, the email provider, the x402 facilitator — to the plugin itself.
Those calls need two things the plugin did not have: the credentials, and permission to
reach the hosts.

- **Secrets (`payment-secrets.ts`).** Four write-only kv keys, following the existing
  `settings:serviceToken` pattern exactly (ADR-0007): `settings:stripeSecretKey`,
  `settings:stripeWebhookSecret`, `settings:emailApiKey` and `settings:x402FacilitatorSecret`
  — the plugin-side homes of what used to be the server-side `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `EMAIL_API_KEY` and `X402_FACILITATOR_SECRET` environment
  variables. Each has a fail-closed reader: a kv read that
  rejects degrades to `undefined` (never throws, never substitutes an empty value that could
  read as "configured"), and one failing read cannot disarm the other three. Values are never
  baked into the bundle and never rendered back into a block — the Settings page grows a
  "Payments & email" group whose fields are plain always-empty text inputs, a blank submit
  keeps the current value, and only a derived boolean ("configured" / which ones are missing)
  ever reaches a label.
- **Egress (`resolveAllowedHosts`).** `allowedHosts` is now resolved from one pure
  function shared by the bundle's `ALLOWED_HOSTS` and the site descriptor, so the two cannot
  drift. What it grants is exactly `api.stripe.com` plus whichever of the
  email/facilitator hosts the deployment supplied via the new `__OTTA_EMAIL_API_URL__` /
  `__OTTA_X402_FACILITATOR_URL__` build defines — an absent or
  unparseable URL grants no host rather than guessing one.

New exports: `PAYMENT_SECRET_KEYS` and the per-secret key constants and readers,
`resolveAllowedHosts`, `STRIPE_API_HOST`, `IN_PROCESS_EGRESS_URLS`, `InProcessEgressUrls`,
and `CommerceMode` / `resolveCommerceMode` re-exported from the package root.
