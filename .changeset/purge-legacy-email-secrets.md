---
"@otta-sh/plugin": patch
---

Once the host's email provider has accepted a send (`state:emailLastSentAt`, newer than any
"no provider" answer), a cron tick deletes the email credentials earlier builds stored
(`settings:emailApiKey`, `settings:emailSmtp2goApiKey` and their save generations), once,
behind the marker `state:legacyEmailSecretsPurged` (ADR-0031). Until then they stay, so a
store still setting up a provider can roll back. Nothing reads them any more,
and a live key should not linger in kv. Stripe and edge-token keys are never touched.
A kv failure part way leaves the marker unset and is retried on a later tick. This is the
point of no return for rolling back to a build that sent through those providers.
