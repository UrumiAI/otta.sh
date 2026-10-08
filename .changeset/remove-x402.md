---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
"@otta-sh/admin-presentation": patch
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
  `x402FacilitatorSecretFromKv` and the `x402Gateway` types. The facilitator URL was the last
  deployment-supplied egress host, so `InProcessEgressUrls`, `IN_PROCESS_EGRESS_URLS` and the
  `__OTTA_X402_FACILITATOR_URL__` build define are gone, and `resolveAllowedHosts()` takes no
  argument: `allowedHosts` is exactly Stripe's API host. Settings no longer shows the x402
  facilitator key, destination wallet or networks fields.
- A cron tick deletes the x402 settings earlier builds stored in plugin kv
  (`settings:x402PayTo`, `settings:x402Accepts`, `settings:x402FacilitatorApiKey` and its
  generation, `settings:x402FacilitatorSecret`), once per store.
- `@otta-sh/admin-presentation`: the "paid on-chain (x402)" refund-capability sentence is gone;
  the record-only copy for a gateway that cannot refund is unchanged.
