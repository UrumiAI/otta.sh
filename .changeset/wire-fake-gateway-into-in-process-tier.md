---
"@otta-sh/plugin": minor
---

`InProcessAdminOrdersClient` now accepts an optional `gateways` constructor option
(`InProcessAdminOrdersClientOptions`, extending `InProcessCommerceStoresOptions`),
mirroring the option `InProcessCommerceClient` already had. Omitted, it defaults to
`{}` — the same "no gateway wired" behaviour as before this change.

`commerce-client-contract.in-process.test.ts` composes a `FakePaymentGateway` for
`stripe` through this option and declares `payments: { method: "stripe" }` on its
`CommerceClientTier`. The shared contract (`commerce-client-contract.ts`) gates two
cases on that hook — the checkout replay and the refund ceiling — and both were
skipping on every tier since the HTTP tier was deleted (INC-D3b); they now run.

Composing a real gateway for the first time surfaced three cases the shared
contract had only ever run speculatively, each corrected here rather than
softened:

- **The refund-ceiling case asserted the wrong reason.** `arrange.order` seeds an
  order with nothing captured, so the domain's `refundOrder` correctly answers
  `NO_CAPTURED_PAYMENT` (checked before the ceiling) rather than
  `REFUND_EXCEEDS_CAPTURED` — a distinct refusal for a short capture, which this
  shared arrange surface has no way to seed. The case is retitled and its
  expectation corrected; no domain or adapter code changed.
- **The refunds-summary case asserted `refundable: false`.** That was honest when
  written — no tier had ever composed a gateway — but `FakePaymentGateway({ id:
  "stripe" })` defaults `refundable: true`, matching real Stripe, and
  `getRefunds` correctly reports the composed gateway's own capability. `true` is
  now the correct expectation.
- **The lapsed-hold case (`RESERVATION_LOST`) was missing a product title on its
  own seed.** Order pricing refuses an untitled row with `PRODUCT_NOT_PRICED`
  before checkout logic ever reaches reservation adoption — documented two cases
  above this one, in the checkout-replay case's own comment, and simply not
  applied here. The seed now carries a title; the domain's reservation-adoption
  path (`create-order-from-cart.ts`, the `inventoryStore.adoptMany` lost-hold
  branch) was traced directly and is unmodified — it was never reached before.

No service, wire, or schema change. `packages/domain` and `packages/store-emdash`
are untouched.
