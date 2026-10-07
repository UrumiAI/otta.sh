---
"@otta-sh/plugin": patch
---

When no from-address is saved, the email sender still falls back to `no-reply@otta.local`, but
now logs once per isolate that `settings:emailFrom` is not set and that real providers refuse
that address, instead of falling back silently (issue #364).
