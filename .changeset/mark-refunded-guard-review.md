---
"@otta-sh/domain": minor
"@otta-sh/payments-stripe": minor
"@otta-sh/plugin": patch
---

Mark refunded's guard, tightened after review:

- Only RECORDED refunds count as money returned. While any refund on the order is reserved or
  unverified, `→ refunded` is refused with `REFUND_IN_FLIGHT` ("A refund on this order is still
  unresolved — check Money → Refunds first") and is not offered (`markRefundedRefusal`).
- `RefundResult`'s failure arm may carry `provider: { refunded, captured }`; the Stripe adapter
  fills it on `PROVIDER_ALREADY_REFUNDED`. `refundOrder` flags the order as fully refunded at the
  provider (unlocking Mark refunded) only when the provider shows the whole capture refunded; a
  partial dashboard refund gets an informational flag naming both amounts, and no figures get no
  flag. The unlocking flag says to mark the order refunded before resolving it.
