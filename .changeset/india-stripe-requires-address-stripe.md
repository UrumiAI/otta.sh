---
"@otta-sh/payments-stripe": minor
---

New `fetchStripeAccountCountry({ secretKey, fetch, timeoutMs? })` (issue #382): one
`GET /v1/account` through the caller's `fetch`, answering the account's two-letter
`country`, or `permission_denied` (403 — a restricted key without account read),
`authentication_failed` (401) or `unavailable` (network, timeout, 5xx/429, or a reply with
no country). Never throws, and never carries the key.
