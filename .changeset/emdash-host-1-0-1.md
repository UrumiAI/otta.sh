---
"@otta-sh/admin-react": minor
"@otta-sh/store-emdash": minor
---

Move the EmDash host from `0.38.0` to `1.0.1`. The `emdash` peer of both packages moves from
exact `0.38.0` to `~1.0.1`, so a site still on EmDash 0.38 now gets a peer conflict: upgrade the
host to 1.0.x alongside this release. The range stops short of 1.1 until a 1.1 host has been
tested (`@otta-sh/admin-react` relies on admin internals such as the sidebar rule and the
Block Kit DOM, and EmDash publishes no semver promise).

The conditional-write primitives (`updateIf`, `getVersioned`, `compareAndSet`,
`compareAndDelete`) and `077_plugin_storage_revisions` are unchanged in 1.0.1. The host adds
migrations `078_menu_item_translation_groups` through `089_auto_seed_completion`, which it runs
on the first request and most of which cannot be rolled back: take a D1 backup or a Time Travel
bookmark before deploying (see `DEPLOYMENT.md`).
