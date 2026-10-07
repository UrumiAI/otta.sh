---
"@otta-sh/admin-react": minor
---

Remove the `/console` shell page from the React admin console.

`/console` ("Console") was the diagnostic landing page that arrived with the
first React descriptor. It managed no data: it rendered a probe of the one
admin route the console calls, and stated the status. Both real screens —
`/orders` and `/products` — now exercise that same route for every row they
render, so the probe was reporting on a path that has two production consumers
proving it continuously. ADR-0015 authorises its removal.

**Breaking (hence `minor` at `0.0.x`).** `CONSOLE_HOME_PAGE` is removed from the
package entry, and the `./admin` entry loses all seven of its other exports:
`ConsoleHomePage`, `ProbePanel`, `probeOttaAdminRoute`, `describeProbe`,
`Probe`, `PROBE_INTERACTION` and `OTTA_ADMIN_ROUTE`. The last of those was a
duplicate of the live constant in `console-api.ts`, which every screen already
uses and which is now the single declaration of the route; import it from there.
`DefinitionRow` and the panel style constants go too, but they were module-
internal and never exported. `OTTA_CONSOLE_ADMIN_PAGES` is now `/orders` and
`/products`, so the sidebar loses its "Console" entry; nothing else moves.

Coverage side effects, stated rather than buried. `test/probe-failure-paths.test.tsx`
is deleted with the code it covered. Two of its assertions were about live code
that survives, and one of those is restored on the surviving path: the
non-JSON-body handling that `console-api.ts` still performs is now covered in
`test/orders-console.test.tsx`. The other is a genuine loss — the pin that the
CSRF header `apiFetch` adds is present on the outgoing request. `console-api.ts`
goes through `apiFetch` exactly as the probe did, so the behaviour is unchanged,
but nothing now asserts it; the tests that remain mock `apiFetch` and therefore
cannot see the header it sets.

The two-descriptor arrangement is unchanged and still proved automatically:
the end-to-end assertion that the Block Kit sidebar group and the React console
group render together — the `adminMode` granularity trap of ADR-0014 Decision 7
— was re-homed onto `/orders` rather than removed with the page it happened to
be written on.
