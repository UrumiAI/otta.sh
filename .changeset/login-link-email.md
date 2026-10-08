---
"@otta-sh/plugin": minor
"@otta-sh/domain": patch
---

Customer login works again: `storefront/account/login/request` emails the magic link
(issue #306). The link goes out through the same email sender as the order emails.

- **The link comes from config, never from the request.** Settings gains a required
  "Sign-in link page" field (`settings:loginLinkUrl`): the absolute http(s) URL of the
  storefront's `/account/verify` page. It is validated on save, and relative paths,
  non-http(s) schemes and URLs carrying a username or password are refused.
  `challenge` and `token` are appended to it. With no valid URL configured, a login
  request answers the same generic success, issues no challenge, sends nothing, and
  logs once. The request origin is never used, so a spoofed `Host` cannot aim a
  victim's link at another domain. Setting and validation adapted from #325 by
  @stephanedemotte.
- The reply stays identical whether the account exists, whether the request was
  throttled, and whether the provider accepted the mail. A throttled request sends
  nothing, and the token appears only inside the emailed link, never in a reply or a
  log.
- With no email provider, a login request also answers the same generic
  success, issues no challenge, and logs once that login email is unconfigured.
- The login email's send is bounded by `LOGIN_EMAIL_TIMEOUT_MS` (3 s) rather than the
  30 s order-email ceiling, because it is awaited inline and a throttled request skips
  it.
- `@otta-sh/domain`: the sign-in email's HTML carries the link as an escaped
  `<a href>`, adapted from #325.
- New public route `storefront/account/logout`: revokes the session (idempotent) and
  returns the cookie the theme should clear.
- `CommerceClient.requestLoginLink` takes an optional `{ verifyPageUrl }`. The account
  route names, paths, result types, `SESSION_COOKIE_NAME`, `LOGIN_LINK_URL_KEY` and
  `isValidLoginLinkUrl` are exported from the package root.
- ADR-0004 is amended: per-IP rate limiting at the gateway is required before
  customers use login.
