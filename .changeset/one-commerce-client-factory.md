---
"@otta-sh/plugin": patch
---

Route every commerce-client construction through one factory.

The six modules that each hand-rolled their own commerce client — the PDP
loader, the cart, checkout and account routes, the entitlement download route
and the content sync hooks — now call a single `makeCommerceClient(ctx)`
composition root, across all nineteen call sites. Nothing observable changes:
the same client, built the same way, from the same plugin context. What it buys
is one place to change how a commerce client is made, instead of nineteen.

`checkEntitlement` is now declared on the `CommerceClient` port rather than only
on the adapter that happened to implement it, so the download route can be
handed the port instead of a concrete class. The adapter already implemented
exactly that signature.
