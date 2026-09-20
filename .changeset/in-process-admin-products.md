---
"@otta-sh/plugin": patch
---

Run the admin Products console on the plugin's own store.

`InProcessAdminProductsClient` answers the console's six admin products methods
(`listProducts`, `getProduct`, `updateProduct`, `restock`, `removeStock`,
`getTaxClasses`) with the `@otta-sh/domain` use-cases composed over the
`@otta-sh/store-emdash` adapters bound to `ctx.storage`. No egress: `ctx.http`
is never touched.

No field is narrowed, because the React screens consume these results through
structural mirrors rather than an imported wire type, so a dropped field would
be invisible to the compiler: `onHand` stays `number | null` and is never
coerced to `0`, `deletedAt` is always present, and every `reason` member keeps
its operands.

Three pieces are behaviour rather than framing and are kept here: the products
list's opaque cursor (position + filter + limit) with its re-validation on
decode and the fail-closed filter/limit disagreement check, the two wire
serializers, and `getTaxClasses` — the unfiltered registry read that sits with
the rules surface even though it is a products method. Inputs are refused at the
boundary through the plugin's own `commerce-input` mirrors, returning the typed
`{ ok: false, reason: "invalid" }` rather than throwing.

`makeAdminClients` is the admin composition root — the console's twin of
`makeCommerceClient` — so which client answers a console read is one factory's
decision rather than each route's. Only `products` is routed through it today;
orders, rules and reporting arrive with their own increments and an absent
surface stays absent rather than being stubbed.

There is no admin auth on this path, deliberately (ADR-0014 D3): the console
runs inside the plugin, so there is no remote caller left to authenticate.

The client contract's admin-products slice runs against this client over a real
per-collection repository, from the same cases the console's own screens use.
