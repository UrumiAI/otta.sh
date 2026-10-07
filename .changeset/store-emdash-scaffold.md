---
"@otta-sh/store-emdash": minor
---

New package: the storage port Otta's commerce adapters will be written against, and a
dialect harness that runs it against a real host repository rather than a stand-in.

- **One structural port, two tiers.** `StorageAccess` names exactly the nine methods an
  adapter needs — `get`/`put`/`delete`/`query`/`count`, and the conditional-write group
  `updateIf`/`getVersioned`/`compareAndSet`/`compareAndDelete`. It is written in terms of
  the host's own storage types, imported as types only, so the filter algebra and the
  result unions are named once rather than copied and left to drift. In production the
  plugin injects `ctx.storage`; in tests the harness injects a real repository. Because
  the port is the only thing an adapter sees, changing which build of the host supplies
  it is a dependency change rather than an adapter rewrite — which is the point.
- **The boundary is enforced, not documented.** Three dependency-cruiser rules replace
  the blanket EmDash ban this package had to be exempted from — it exists to name the
  host's types, so the blanket ban forbade the one import it is for.
  `store-emdash-runs-no-host-code` says the host may be *named* and never *executed*: a
  type import passes, a runtime import of the same module fails `pnpm lint`. It is its own
  rule so that allowance cannot leak onto the others — written as one clause it also
  permitted `import type { Pool } from "pg"`. `store-emdash-is-sandbox-clean` carries the
  perimeter: no DB driver, no filesystem or socket builtin, no HTTP client, no sibling
  server package (matched by lookahead, so a future store package is banned the day it
  exists). `store-emdash-no-console-react` keeps react, react-dom and the two component
  libraries out of the **whole** package, tests included. Four plants prove each edge:
  runtime host import fails, `react` in a test fails, a type-only host import passes, a
  type-only `pg` import fails.
- **The host it needs does not exist on the registry yet, and the manifest says so.** The
  port is written against the conditional-write primitives, which no published `emdash`
  release carries. The specifier stays the plain registry version so adopting a release is
  a one-line change; until then the workspace override that redirects it to a build
  carrying the primitives is load-bearing, and the package description, the README and
  this note all say that rather than letting an exact peer pin imply a compatibility that
  does not hold.
- **Real databases, never mocks — including the one that can race.** The harness builds
  its collections out of real repository instances over in-memory SQLite and, when a
  Postgres connection is configured, over a fresh schema migrated by the host's own
  migration runner. Never a hand-built table: revisions come from a trigger that
  migration creates, and without it every compare-and-set would see an unchanging
  revision and quietly agree with itself. One database per test file, rows cleared
  between cases — emptying the table is also the only reset that keeps that trigger. The
  suite pins the round trip, the indexed query with ordering and paging past the host's
  page ceiling, `count`, `delete`, the guarded decrement that stops at its guard, the
  guarded update that never inserts, create-if-absent, the stale-revision refusals for
  both set and delete, and the refusal to query a field the collection never declared
  (asserted on the field, not on the host's wording). A collection declared with a unique
  index proves the composed allow-list — and the README records what that does NOT buy:
  no physical index exists in either tier, so uniqueness is never enforced there and
  once-only must come from a conditional write. On Postgres it adds the case SQLite
  cannot express: ten concurrent compare-and-sets on one revision, exactly one of which
  applies, every loser either refused or retryably aborted, and the surviving document
  the winner's.
