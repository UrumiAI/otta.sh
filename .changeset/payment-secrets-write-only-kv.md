---
"@otta-sh/plugin": minor
---

Provision the payment credentials in write-only plugin kv, and widen the egress
allowlist to the hosts that now need reaching (work order 02, INC-C3).

Running commerce inside the plugin moves the outbound calls that used to be made
server-side — Stripe's API and the x402 facilitator — to the plugin itself.
Those calls need two things the plugin did not have: the credentials, and permission to
reach the hosts.

- **Secrets (`payment-secrets.ts`).** Three write-only kv keys, following the existing
  `settings:serviceToken` pattern exactly (ADR-0007): `settings:stripeSecretKey`,
  `settings:stripeWebhookSecret` and `settings:x402FacilitatorApiKey`
  — the plugin-side homes of what used to be the server-side `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET` and `X402_FACILITATOR_SECRET` environment
  variables. (This increment first named the x402 key `settings:x402FacilitatorSecret`;
  a later pre-release change renamed it, because its value changed from an offline HMAC
  secret to a bearer credential sent to the facilitator. The old key is never read.)
  Each has a fail-closed reader: a kv read that rejects degrades to `undefined` (never
  throws, never substitutes an empty value that could read as "configured"), and one
  failing read cannot disarm the other three. Values are never baked into the bundle and
  never rendered back into a block — the Settings page grows a "Payments & email" group
  whose fields are plain always-empty text inputs, a blank submit keeps the current value,
  and only a derived boolean ("configured" / which ones are missing)
  ever reaches a label.
- **Egress (`resolveAllowedHosts`).** `allowedHosts` is now resolved from one pure
  function shared by the bundle's `ALLOWED_HOSTS` and the site descriptor, so the two cannot
  drift. What it grants is exactly `api.stripe.com` plus the facilitator host the
  deployment supplied via the new `__OTTA_X402_FACILITATOR_URL__` build define — an absent or
  unparseable URL grants no host rather than guessing one.

New exports: `PAYMENT_SECRET_KEYS` and the per-secret key constants and readers,
`resolveAllowedHosts`, `STRIPE_API_HOST`, `IN_PROCESS_EGRESS_URLS`, `InProcessEgressUrls`,
and `CommerceMode` / `resolveCommerceMode` re-exported from the package root.
