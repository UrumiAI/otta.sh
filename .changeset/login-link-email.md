---
"@otta-sh/plugin": minor
---

Customer login works again: `storefront/account/login/request` emails the magic link
(issue #306). The link goes out through `CtxHttpEmailSender` over `ctx.http` — the
same egress and `allowedHosts` entry the order emails use — and points at the
storefront's `/account/verify?challenge=…&token=…` page, built from
`settings:storefrontBaseUrl` when set or else the request's own origin (never caller
input, so a link cannot be aimed at another host).

- The reply stays identical whether the account exists, whether the request was
  throttled, and whether the provider accepted the mail. A throttled request sends
  nothing; the token appears only inside the emailed link, never in a reply or a log.
- With no email API URL in the build, a login request still answers the same generic
  success, issues no challenge, and logs once that login email is unconfigured.
- New public route `storefront/account/logout`: revokes the session (idempotent) and
  returns the cookie the theme should clear.
- `CommerceClient.requestLoginLink` takes an optional `{ linkBaseUrl }`; the account
  route names, paths, result types and `SESSION_COOKIE_NAME` are now exported from
  the package root.
