---
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": minor
---

Storage contention now degrades to a retryable "busy" answer instead of a
generic failure or a host 500.

- `@otta-sh/store-emdash` exports `isRetryableStorageBusy(err)` — the one
  structural predicate (never `instanceof`, so it survives the sandbox bridge)
  for "nothing was written by the step that gave up; safe to retry": a
  `StorageContentionError`, or a host `StorageSerializationError` marked
  `retryable`. It does not look into `cause`: a wrapping error may have written
  before it failed.
- `renderGuard` (every public storefront route) answers
  `{ ok: false, error: "BUSY", retryable: true }` for storage pressure, and
  `RENDER_FAILED` for everything else. Every storefront result union now ends in
  the exported `RenderGuardFailure` type, so consumers matching on `error` see
  the new member. **Additive on the wire, but an exhaustive `switch` over a
  route result's `error` must handle `"BUSY"`.**
- `webhooks/stripe/settle` returns `status: 503,
  reason: "BUSY", retryable: true` rather than throwing (a distinct member of
  each result union). Stripe retries a 503, and a redelivery
  is replay-safe: the domain dedupes on the event id / receipt (tested, including
  a redelivery after the first attempt had already settled).
- `entitlements/download` returns `{ authorized: false, reason: "BUSY",
  retryable: true }` rather than throwing — never `NOT_ENTITLED` for a paying
  buyer.
- The React console's orders/products surfaces answer the new `STORE_BUSY`
  refusal (retryable, its own copy) instead of the generic "unavailable" one.
- Every busy shape now carries `retryable: true` alongside its existing token
  (`error: "BUSY"`, `reason: "BUSY"`, or the `STORE_BUSY` console refusal); no
  token was renamed.

Reference site (`sites/staging`, private — not published, noted here because it
ships with this change):

- **Security fix — open redirect via dot segments.** `safeReturnPath` (the
  `/cart/add` `returnTo` guard) accepted `/.//evil.com`, `/..//evil.com`,
  `/a/../..//evil.com` and percent-encoded forms (`/%2e%2e//evil.com`): each
  passes a string check but RESOLVES to the protocol-relative `//evil.com`, so
  the 303 `Location` left the site. The guard now resolves the path, re-validates
  the RESOLVED value and returns only that normalized value; `seeOther` and the
  busy page's "Go back" link normalize through the same check.
- A form POST still busy after the site's retry answers 503 + a short
  `Retry-After`; SSR pages that end busy (home included) are marked 503. The one
  automatic site retry is an explicit allowlist — read routes plus the keyed
  cart-line add/update/remove — so every other route, including future ones, is
  never auto-retried. A busy `cart/create` on `/cart/add` is the busy 503, not
  `SERVICE_UNAVAILABLE`.
- `GET /checkout` with a busy summary intentionally keeps its 303 to
  `/cart?error=BUSY` rather than a 503: it is a buyer-only transactional page,
  and `/cart` shows the busy copy (and itself answers 503 if still busy).
