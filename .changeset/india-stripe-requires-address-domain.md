---
"@otta-sh/domain": minor
---

`CreateOrderCommand` gains an optional `addressRequired` (issue #382). When `true`,
`createOrderFromCart` refuses a checkout with no shipping address as
`MISSING_SHIPPING_ADDRESS` for ANY cart — digital-only and no-zone carts included — at the
same point as ADR-0021's zoned-physical refusal, so nothing is minted or redeemed. A
same-key replay still short-circuits before the check. Absent or `false`, nothing changes.

The payment intent's provider-side customer decision is now recorded once per order and
handed back on every replay (issue #382). `PaymentIntentHandle` and `CreateIntentInput` gain
an optional `customerRef` (`cus_…`, or `null` for "none"), as do `RecordPaymentIntentInput`
and `PaymentIntentRecord`. `createOrderFromCart` records it with the order's intent, and a
same-key replay (a resume, the locked review's retry) passes the earliest recorded decision
back to the gateway, so the gateway does not decide again and its same-key request stays
byte-identical. Intents recorded without one behave exactly as before. A store
implementing `OrderStore` must persist `customerRef` when it is given; the contract suite
pins it.
