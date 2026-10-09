---
"@otta-sh/plugin": patch
"@otta-sh/store-emdash": patch
---

Correct the published package metadata and READMEs. The `@otta-sh/plugin` description no longer
says the plugin has no storage (it runs commerce in-process on the host-injected `ctx.storage`), and
its README drops the removed HTTP commerce client, the build-time transport flag and the deleted HTTP
contract tier, and records that the Stripe gateway is wired. The `@otta-sh/store-emdash`
description and README no longer claim a vendored `emdash` build and workspace override are
required: the conditional-write primitives ship in the published `emdash@0.38.0`. Documentation and
metadata only — no code or behaviour change.
