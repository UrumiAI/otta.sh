---
"@otta-sh/domain": patch
"@otta-sh/plugin": patch
---

Small tax hardening (#430): the "based on cart items" shipping tax class now picks by
class name ignoring accents as well as case (ties broken by the lower id),
and registering a tax calculator over an existing one logs a `console.warn` instead of
replacing it silently.
