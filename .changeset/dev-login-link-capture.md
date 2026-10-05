---
"@otta-sh/plugin": patch
---

A dev-only login-link capture, so a local or CI e2e stack can sign a shopper in through the
real UI (follow-up to issue #378). The sign-in email goes out through `ctx.http`, which
refuses loopback, so no local mailbox can receive it. `makeLoginEmailSender` still returns no
sender when the bundle has no email API URL. The one exception: when the site bakes the
build-time define `__OTTA_DEV_LOGIN_CAPTURE__` as `true` AND the bundle is a Vite dev build
(`import.meta.env.DEV`), the login link is written to the plugin's own kv under
`e2e:loginLink:<lower-cased address>` instead of being mailed, keeping only the newest
`DEV_LOGIN_CAPTURE_MAX_ROWS` (20) captures. No route reads it; the e2e
harness reads the dev server's local database file. The gates are the offline Stripe
gateway's: the site-baked define is the primary one (the staging site bakes it only under
`astro dev` with `OTTA_E2E_LOGIN_CAPTURE=1`, and `astro build` refuses the variable), and
`import.meta.env.DEV` is defence in depth. A configured email provider always gets the real
sender, and order emails never take this path. `DEV_LOGIN_CAPTURE_KEY_PREFIX`,
`DEV_LOGIN_CAPTURE_MAX_ROWS`, `devLoginCaptureKey` and the `CapturedLoginLink` type are exported for the harness.
