---
"@otta-sh/plugin": patch
---

Route every commerce-client construction through one factory.

The six modules that each hand-rolled the same `new HttpCommerceClient({ fetch:
ctx.http.fetch, baseUrl, …serviceToken })` — the PDP loader, the cart, checkout
and account routes, the entitlement download route and the content sync hooks —
now call a single `makeCommerceClient(ctx)` composition root, across all
nineteen call sites. Nothing about the wire changes: the same base URL, the
same `ctx.http.fetch` as the only egress, and the same write-gate token read
from write-only plugin kv, with an unset token still attaching no header at all.

`checkEntitlement` is now declared on the `CommerceClient` port rather than only
on the HTTP adapter, so the download route can be handed the port instead of the
concrete class. The adapter already implemented exactly that signature.

A build-time `__OTTA_COMMERCE_MODE__` define selects the transport, defaulting to
`"http"` wherever no bundler sets it. It is deliberately temporary: it exists
only so an upcoming in-process commerce client can be run against the same
behavioural contract as the HTTP one before the HTTP transport is removed, and
both the flag and the branch it drives are deleted with that transport.
