---
"@otta-sh/plugin": patch
---

The first cron tick after upgrading deletes the email credentials earlier builds stored
(`settings:emailApiKey`, `settings:emailSmtp2goApiKey` and their save generations), once,
behind the marker `state:legacyEmailSecretsPurged` (ADR-0031). Nothing reads them any more,
and a live key should not linger in kv. Stripe, x402 and edge-token keys are never touched.
A kv failure part way leaves the marker unset and is retried on a later tick. This is the
point of no return for rolling back to a build that sent through those providers.
