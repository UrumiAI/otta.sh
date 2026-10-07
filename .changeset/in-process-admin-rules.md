---
"@otta-sh/plugin": patch
---

Run the admin Shipping, Tax and Coupons consoles on the plugin's own store.

`InProcessAdminRulesClient` is the console's whole rules surface in one client —
twenty-five methods (`listZones`, `createZone`, `updateZone`, `deleteZone`,
`listMethods`, `createMethod`, `updateMethod`, `deleteMethod`, `getRate`,
`createRate`, `updateRate`, `deleteRate`, `listTaxClasses`, `createTaxClass`,
`updateTaxClass`, `deleteTaxClass`, `listTaxRates`, `createTaxRate`,
`updateTaxRate`, `deleteTaxRate`, `listCoupons`, `getCoupon`, `createCoupon`,
`updateCoupon`, `deleteCoupon`), with the `@otta-sh/domain` ports composed over
the `@otta-sh/store-emdash` adapters bound to `ctx.storage`. No egress: nothing
here leaves the process.

No field is narrowed, and two shapes stay deliberately apart: the coupon detail
read omits `startsAt`/`expiresAt`, while the list row carries them plus
`createdAt`, because the console renders the validity window straight off the
list rather than fetching each row's detail.
`CouponsListResult.total` is present on every page and an absent total is never
spelled `0`.

Last-writer-wins versus compare-and-set stays per entity rather than being
homogenized. Zones, shipping methods, tax classes and coupons carry no money and
edit LWW; shipping rates and tax rates are CAS, and the CAS token is the
money/rate field itself (`expectedAmountCents`, `expectedRateBps`) rather than a
version counter, so a losing edit comes back `stale` carrying the fresh row. The
full-replace edits keep their required-nullable keys — `regions`,
`minSubtotalCents`, `appliesToShipping` — so an omitted key is refused instead of
silently wiping a zone's match list, a free-shipping threshold or a rate's
shipping behaviour.

Two pieces that used to sit in a route layer are behaviour rather than framing,
and so live in the client. The coupons list's opaque cursor (position + filter +
limit) is re-validated on decode and its limit re-clamped, and the predicate
comes solely from the token when one is present. And the coupon-economics rule
that closed issue #75 — a `fixed_amount` coupon may not lose its `amountCents`,
a `percentage` coupon may not lose its `rateBps` — is enforced as
fetch-then-validate: the coupon is read to learn its immutable type, then the
edit is refused before any write.

`deleteTaxClass` keeps its own result type because it is the one delete on this
surface composed over two aggregates: it counts referencing products first, then
referencing rates, and each refusal carries the count, so the console can say what
is in the way. The leaf rate deletes never answer `in_use`, and every delete is
idempotent.

Input-shape refusals reject rather than resolving to a synthesized status, so
`RulesCreateResult`'s reason-less `{ ok: false, status }` arm goes unused here
rather than being faked. The coupon-economics refusal is the exception and
answers with a reason, because it is ported route behaviour rather than a
boundary check.

The in-process client takes no admin or service token (ADR-0014 D3): EmDash's own
admin auth and CSRF gate the console routes, and there is no service to
authenticate to. `makeAdminClients` now routes `rules` alongside `products` and
`orders`; reporting arrives with its own increment and an absent surface stays
absent rather than being stubbed. The Shipping, Tax and Coupons console routes
read their client through the factory instead of constructing one directly.

The client contract's admin-rules slice now covers all twenty-five methods,
running over a real per-collection repository — including the registry reads,
the LWW method and tax-class edits, the per-currency rate read whose absence is
`null`, both referential arms of the tax-class delete, and the #75 coupon rule.
