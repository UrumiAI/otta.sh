---
"@otta-sh/plugin": patch
---

Run the admin Products console on the plugin's own store.

`InProcessAdminProductsClient` is the in-process twin of `AdminProductsClient` —
the same six methods (`listProducts`, `getProduct`, `updateProduct`, `restock`,
`removeStock`, `getTaxClasses`), the same argument shapes and the same return
values field for field, with the `@otta-sh/domain` use-cases composed over the
`@otta-sh/store-emdash` adapters bound to `ctx.storage` instead of a commerce
service. No egress: `ctx.http` is never touched.

No field is narrowed, because the React screens consume these results through
structural mirrors rather than an imported wire type, so a dropped field would
be invisible to the compiler: `onHand` stays `number | null` and is never
coerced to `0`, `deletedAt` is always present, and every `reason` member keeps
its operands.

Three pieces of the service's route layer are behaviour rather than framing and
are mirrored here: the products list's opaque cursor (position + filter + limit)
with its re-validation on decode and the fail-closed filter/limit disagreement
check, the two wire serializers, and `getTaxClasses` — the unfiltered registry
read that lives in the service's rules route even though it is a products
method. Inputs are refused at the boundary through the plugin's own
`commerce-input` mirrors, returning the typed `{ ok: false, reason: "invalid" }`
where the other transport's 400 produced one and rejecting where it threw.

`makeAdminClients` is the admin composition root — the console's twin of
`makeCommerceClient` — so which tier answers a console read is one factory's
decision rather than each route's. Only `products` is routed through it today;
orders, rules and reporting arrive with their own increments and an absent
surface stays absent rather than being stubbed. The route now reads the admin
tokens once per request and hands them to the factory, instead of each of them
reading write-only kv separately.

There is no admin auth in the in-process branch, deliberately (ADR-0014 D3): the
`X-Internal-Token` / `X-Service-Token` pair authenticates a caller to the
service, and in-process there is no service to authenticate to.

The client contract's admin-products slice now runs on BOTH transports from the
same cases — the in-process tier over a real per-collection repository, the HTTP
tier over a live service.
