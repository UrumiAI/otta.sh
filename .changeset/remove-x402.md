---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
"@otta-sh/admin-presentation": minor
"@otta-sh/admin-react": patch
---

Remove x402 (HTTP 402, USDC on Base) from Otta. Stripe, checkout, orders, refunds, downloads
and email are unchanged. At `0.x` the `minor` here IS the breaking bump: every item below is a
removal from published API.

- `@otta-sh/payments-x402` is deleted. It was never released.
- `@otta-sh/domain`: removed the `X402Rail` port and its types (`X402Offer`, `X402Proof`,
  `X402VerifyResult` and the rest), the `x402_challenge` client action and the `page_gate`
  confirmation. `PaymentMethod` is now `"stripe"` (still a type alias, the seam for a further
  gateway) and `EntitlementSource` is `"order_paid"`. `FakePaymentGateway` defaults to
  `refundable: true`, loses `pageGate()` and gains `setRefundable()`.
- `@otta-sh/plugin`: removed `wireX402Gateway`, `x402GatewayFromCtx`, `X402_PAYTO_KEY`,
  `X402_ACCEPTS_KEY`, `DEFAULT_X402_ACCEPTS`, `X402_FACILITATOR_API_KEY_KEY`,
  `x402FacilitatorSecretFromKv` and the `x402Gateway` types. `InProcessEgressUrls` loses
  `facilitatorUrl` and the `__OTTA_X402_FACILITATOR_URL__` build define is gone: the facilitator
  host is no longer on `allowedHosts`, which is now Stripe's API host alone. The egress
  plumbing itself (`InProcessEgressUrls`, `IN_PROCESS_EGRESS_URLS`, `resolveAllowedHosts`,
  `resolveInProcessEgress`) is kept for operator-supplied hosts. Settings no longer shows the
  x402 facilitator key, destination wallet or networks fields.
- A cron tick deletes the x402 settings earlier builds stored in plugin kv
  (`settings:x402PayTo`, `settings:x402Accepts`, `settings:x402FacilitatorApiKey` and its
  generation, `settings:x402FacilitatorSecret` and its generation), once per store.
- Orders placed with x402 before its removal still store `paymentMethod: "x402"`. Their refunds
  are record-only: the admin refund action records a manual refund (ledgered under `x402`, no
  money moves), where it would otherwise answer `409 REFUND_GATEWAY_UNAVAILABLE`. A Stripe order
  with no Stripe gateway configured still answers 409. The admin refunds summary
  (`RefundsSummaryWire`) gains `legacyPaymentMethod: boolean`, true for such an order.
- `@otta-sh/admin-presentation`: the "paid on-chain (x402)" refund-capability sentence is gone.
  `refundCapabilityText` takes a third argument, `legacyPaymentMethod`; when it is true the
  panel reads "Paid with a payment method Otta no longer supports. Refunds are record-only:
  return the money outside Otta, then record it here." The Stripe and record-only sentences are
  worded as before.
- `@otta-sh/admin-react`: the order's Money tab passes the summary's `legacyPaymentMethod`
  through, so a legacy x402 order shows that sentence.
- The late-refund and intent-cancel sweeps reserve 2 queries, not 5, for resolving the payment
  gateways: Stripe's two secret reads, now the only gateway.
