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

The yes/no is now the ORDER's own: `createOrderFromCart` freezes
`Order.buyerAddressRequired` (the `addressRequired` the checkout enforced) in the creating
insert, and `CreateIntentInput.customerRequired` is derived from it — placed under the
requirement AND holding an address — for the first intent, every replay and every resume.
The place check and the payment therefore answer from one snapshot, and neither a lost
intent record nor a change in the account's cached country can change a same-key intent.
`customerRef` still records WHICH customer, so the same one is reused after the provider's
idempotency key lapses. `CreateOrderInput` gains the optional `buyerAddressRequired`; orders
created without it carry none, and their gateway decides as before.
