---
"@otta-sh/admin-react": minor
---

New package `@otta-sh/admin-react` — the React admin console's shell, served by
a SECOND EmDash descriptor `otta-console` (`format: "native"`) alongside the
untouched Block Kit `otta` plugin (ADR-0014).

`@otta-sh/plugin` is unchanged by this: still `format: "standard"`, still
sandbox-clean, still **zero EmDash dependency**, `packages/plugin/src/types.ts`
still a hand-written mirror, all 18 workerd sandbox suites still green
(ADR-0006 Decision 1, reaffirmed). No screen is migrated — Orders and Pricing &
inventory move later, and Tax, Shipping and Settings never do.

- The descriptor declares `format: "native"` **literally**, `capabilities: []`
  and `allowedHosts: []`, and points both `entrypoint` and `adminEntry` into
  this package. Every one of those is a hard pin in
  `sites/staging/test/site-config.test.ts`, negative fixtures included: a
  descriptor that inherits `format` from EmDash's default, or that aims
  `adminEntry` at `@otta-sh/plugin`, fails the suite.
- Two descriptor ids is a requirement, not a style choice. Sidebar visibility is
  derived **per plugin id**, so one React page under id `otta` would make that
  plugin's seven Block Kit screens vanish from the nav while still rendering at
  their URLs. A Playwright spec asserts both groups are present.
- The console's only data path is HTTP to the existing authenticated `otta`
  admin routes, with the operator's own session — verified end to end (HTTP
  200, `[success, data]` envelope). It owns no hooks, no routes, no storage and
  no capabilities, and a new dependency-cruiser rule
  (`console-imports-no-workspace-package`) stops it acquiring a second data path
  by importing `@otta-sh/plugin` or any other workspace package.
- Two peers only, `react` and `emdash` — no `@cloudflare/kumo` and no
  `@phosphor-icons/react`, which the spike measured as optional rather than
  required. No component library, no CSS file, no money rendering.
