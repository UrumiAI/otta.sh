---
"@otta-sh/plugin": minor
"@otta-sh/domain": minor
---

Customer sign-in works end to end (#306).

- **The magic link is emailed.** `requestLoginLink` sends each issued challenge
  through the same `EmailSender` as the order emails. A throttled or malformed
  request sends nothing and answers the same generic success. A transport failure
  rejects, because it is infrastructure and happens for every address alike.
- **The link comes from config, never from the request.** Settings gains the
  sign-in link page (`settings:loginLinkUrl`, an absolute http(s) URL, validated on
  save). The challenge id and token are appended as `challengeId` and `token`.
  With no page configured, or no email API URL in the build, nothing is sent.
- **French copy.** `settings:emailLocale` (`en` default, `fr`) picks the sign-in
  email's language. The HTML now carries an escaped `<a href>`.
- **Logout.** A new public route, `storefront/account/logout`, takes
  `{ sessionToken }`, revokes the session, and returns a cookie descriptor that
  clears `otta_session`. It is idempotent.
