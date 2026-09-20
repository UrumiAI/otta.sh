---
"@otta-sh/admin-react": patch
"@otta-sh/store-emdash": patch
---

Move the EmDash host pin off the vendored build and onto the released `emdash@0.38.0`: the
`emdash` peer moves from exact `0.37.0` to exact `0.38.0`, and `@emdash-cms/cloudflare`
moves to `0.38.0` alongside it. `0.38.0` is the first release carrying the conditional-write
primitives (`updateIf`, `getVersioned`, `compareAndSet`, `compareAndDelete`) that the repo
previously had to vendor a local build to obtain, and its migration runner is byte-identical
to the vendored one — same 76 migrations, same order, same `077_plugin_storage_revisions`
tail — so this is a dependency-range change only, with no behavioural change and no database
reconciliation.
