---
"@otta-sh/plugin": patch
---

Re-export the sign-in link's per-address cap and lifetime as `LOGIN_LINK_MAX_ACTIVE` and
`LOGIN_LINK_TTL_MS` (the in-process verifier's defaults), so a storefront's copy about them
cannot drift.
