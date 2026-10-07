---
"@otta-sh/plugin": minor
---

**New `storefront/account/me` route (`ACCOUNT_ME_ROUTE`, `AccountMeResult`)** and
`CommerceClient.getMyAccount(sessionToken)`: the session's own email, read off the
session's customer, for a storefront that greets a signed-in shopper or prefills
checkout. Signed out — no session, an unusable one, or one whose customer is gone —
answers `{ ok: false, redirectTo }`, never an error.

**BREAKING** for an out-of-tree `CommerceClient` implementation: `getMyAccount` is a new
required method.
