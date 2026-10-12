# Contract suites

Behavioural specs written once against a tier interface, so the spec stays separate from any one
implementation's construction detail. A case that fails is a defect in the implementation, never a
case to soften.

## `commerce-client-contract.ts`

The commerce client's behavioural spec: every case is *arrange backend state* → *call a client
method* → *assert the returned value or typed rejection*. No URLs, headers or status codes. Three
slices:

- `storefrontCommerceClientContract` — the storefront `CommerceClient`;
- `adminOrdersProductsClientContract` — the admin orders and products surfaces;
- `adminRulesReportingClientContract` — shipping, tax and coupon rules, reporting and settings.

It runs in one tier, `test/commerce-client-contract.in-process.test.ts`: `InProcessCommerceClient`
over a real document store (the host's `PluginStorageRepository` on in-memory SQLite, migrated by
the host's own migrations), with `ctx.http` bound to a rejecting stub so a method that reached for
egress fails the suite.

```bash
pnpm --filter @otta-sh/plugin exec vitest run test/commerce-client-contract.in-process.test.ts
```

### The tier interface (`CommerceClientTier`)

- `setup()` / `teardown()` once per slice, `reset()` before each case (the in-process tier clears
  rows), `makeClient()`, and `makeAdminClients()` for the admin slices — an admin slice bound to a
  tier without it throws at collection (`assertAdminClients`).
- Admin surfaces other than `products` are typed optional and read through `requireSurface`, which
  throws naming the tier and the missing surface. A missing surface fails loudly; it is never
  replaced by a stub that would pass against nothing.
- `arrange` seeds state: `product`, `cart`, `session`, `order`, `settle`, `address`,
  `shippingMethod`, `coupon`, `taxClass`. `session(email)` mints a real session through the
  credential verifier and the client's own `verifyLogin`, never by writing a session row. The
  port-level seeders share one implementation, `test/helpers/commerce-tier-arrange.ts`.
- Optional hooks: `clock.advance(ms)` (elapsed-deadline cases), `payments` (a composed gateway, so
  checkout and refund cases can succeed; the in-process tier composes a `FakePaymentGateway` for
  `stripe`) and `throttleDocuments`. A case gated on a hook names the gate in its own title. The
  in-process tier declares all of them.

### Rules the cases follow

- **Seeding path.** A case whose subject is a write method calls it directly; a case that only
  needs state uses `tier.arrange.*`. A state with exactly one writer is arranged through that
  writer.
- **Disjoint ids.** Every case uses its own product ids, skus, cart ids, coupon codes, idempotency
  keys and email, and no case depends on another's leftovers.
- **Ordered products carry a `title`.** Order pricing snapshots price and title onto the line, so
  an untitled row is refused `PRODUCT_NOT_PRICED`.
- **Rejections are awaited.** Typed failures are asserted as values; a malformed input is asserted
  as an awaited rejection (`expectRejectedInput`), with the `INVALID_INPUT` code and field checked
  when the error carries one, and never a status.
- **Reporting windows come from the data** (`windowAroundOrder`), never from the wall clock.
- **Money is integer minor units** with an explicit ISO 4217 currency throughout.

## `download-route-contract.ts`

The spec of the `entitlements/download` route (issue #376): it answers
`{ authorized: true, sku, asset }` only when the whole delivery gate holds (an active grant, an
order whose money was kept, a live digital product, a descriptor bound to it), and the single
`{ authorized: false, reason: "NOT_FOUND" }` otherwise; malformed input is `INVALID_INPUT`. It runs
in two tiers: in-process (`test/download-route.in-process.test.ts`) and inside the workerd-on-Node
sandbox (`test/download-route.sandbox.test.ts`).
