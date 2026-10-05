---
"@otta-sh/payments-stripe": minor
---

India-based Stripe accounts (issue #382):

- New `fetchStripeAccountCountry({ secretKey, fetch, timeoutMs? })`: one `GET /v1/account`
  through the caller's `fetch`, answering the account's two-letter `country`, or
  `permission_denied` (403 — a restricted key without read access to account details),
  `authentication_failed` (401) or `unavailable` (network, timeout, 5xx/429, or a reply
  with no country). Never throws, and never carries the key.
- New gateway option `customerRequired: () => Promise<boolean>`. When it answers `true`
  and the order captured an address, `createIntent` first creates a Stripe Customer
  (`POST /v1/customers` with `name` and `address[line1|line2|city|state|postal_code|country]`,
  Idempotency-Key `otta-cus-<orderId>`), then passes `customer=cus_…` on the PaymentIntent,
  right after `description`. Stripe requires the customer's name and billing address for
  every international payment an India account takes. A replay of the same order gets the
  same Customer back by its key, so the intent body stays byte-identical. A failed Customer
  create throws the same `PaymentIntentError` as a failed intent create (retryable on
  network/5xx/429/409, terminal on other 4xx), before any intent is asked for. The
  transport seam gains an optional `createCustomer`. With the option absent or `false`,
  no Customer is created and the intent body is unchanged.

  The Customer also carries `metadata[order_id]`. It is decided **once per order**:
  `createIntent` returns the decision as the handle's `customerRef` (`cus_…`, or `null` for
  none), the domain records it with the intent, and a replay passes it back as
  `CreateIntentInput.customerRef`. The gateway then names that Customer again (or none)
  without asking `customerRequired` and without creating another, so the same-key intent
  body stays byte-identical even if the account's cached country changed or Stripe pruned
  the Customer's key. Every live intent now returns a `customerRef`.
