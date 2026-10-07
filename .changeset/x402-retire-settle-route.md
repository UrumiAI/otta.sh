---
"@otta-sh/payments-x402": minor
"@otta-sh/plugin": minor
---

Retire the x402 receipt-forwarding path (ADR-0028, increment 2 of 8). At `0.x` the `minor`
here IS the breaking bump: every item below is a removal from published API.

Nothing ever called it. The public `entitlements/x402/settle` route settled only an
existing order with `paymentMethod: "x402"`, and checkout creates none (it hardcodes
`PAYMENT_METHOD = "stripe"`). It was also the only surface that turned client-supplied
JSON into a `page_gate` confirmation, and the "receipt" it forwarded is a shape no
standard x402 facilitator verifies. ADR-0028 replaces the model: the resource server will
call the facilitator's standard `/verify` and `/settle` itself, from a domain use case
that is the only thing able to build a `page_gate` confirmation. Deleting the old path
first makes Decision 2's invariant true from this release on: no client-supplied JSON
reaches a `page_gate` confirmation.

- `@otta-sh/plugin`: the `entitlements/x402/settle` route is no longer registered. Removed
  exports: `createX402SettleHandler`, `X402_SETTLE_ROUTE`, `x402SettleResultToResponse`,
  `X402SettleInput`, `X402SettleReason` and `X402SettleResult`. `WireX402Options` loses
  `fetch` and `facilitatorApiKey`: the x402 wiring no longer builds a facilitator, so it
  needs no transport and no longer reads `settings:x402FacilitatorApiKey`. The setting
  still saves, for the facilitator client a later increment adds. A deployment with a
  facilitator URL and a valid `payTo` still gets an x402 gateway, for its challenge, its
  `refundable = false` and its `UNSUPPORTED` refund and cancel answers. The Settings
  copy no longer promises an x402 checkout: the facilitator key's removal note and the
  payment-settings note now say x402 payments are not available yet. Every field still
  saves.
- `@otta-sh/payments-x402`: removed `createHttpFacilitator`, `createTestFacilitator`,
  `signX402Proof`, `X402FacilitatorUnavailableError`, the `X402Facilitator` interface (and
  its `verifyReceipt`), `X402VerifyResult`, `HttpFacilitatorOptions` and
  `DEFAULT_FACILITATOR_TIMEOUT_MS`. `X402PaymentGatewayOptions` no longer takes a
  `facilitator`. `X402PaymentGateway.verifyConfirmation` now refuses every confirmation,
  `page_gate` included, with `MALFORMED`, until ADR-0028 increment 7 gives `page_gate` a
  value only the domain can mint.

Also corrects two key names in earlier, unreleased changesets (#283): the edge token's kv
key is `settings:otta-wh-token`, and the x402 facilitator credential's is
`settings:x402FacilitatorApiKey`.
