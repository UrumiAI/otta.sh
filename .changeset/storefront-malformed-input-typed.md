---
"@otta-sh/plugin": minor
---

The storefront routes answer a malformed id or an over-cap quantity with the
typed refusal it means, instead of RENDER_FAILED.

The in-process commerce client bounds opaque ids (1–200 printable ASCII
characters, no whitespace) and cart quantities (at most 10,000) by throwing, and
the routes passed those inputs straight through — so a 3,000-character order
id, a sign-in link with an over-long challenge, or a quantity of 10,001 became
`RENDER_FAILED`: an error-level log for the caller's own input, and on the site
an outage page (a 503 on the account order page) where "not found" or "invalid
link" was the truth.

- `storefront/order`: any string that cannot be an order id (blank, over-long,
  whitespace or control characters) is `ORDER_NOT_FOUND`; only a missing or
  non-string id is `INVALID_INPUT`.
- `storefront/account/order`: such an id is `NOT_FOUND`, like any other order
  that is not the customer's.
- `storefront/account/login/verify`: a challenge id that cannot be one, or a
  token over 400 characters, is the `INVALID` link reason.
- `storefront/cart/lines/add` and `/update`: a quantity over 10,000 (per
  request) is the new typed `{ ok: false, error: "QTY_TOO_LARGE" }`, so a
  storefront can name the limit.

**Minor, for an additive wire-union member:** `QTY_TOO_LARGE` is added to
`CartLineMutationRouteResult`, so a caller that switches exhaustively over that
union needs the new case. Every other answer was already in its route's result
union.
