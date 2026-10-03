---
"@otta-sh/plugin": minor
---

New public route `storefront/order/abandon` and `CommerceClient.abandonCartOrder` (QA2
X4). "Start a new cart" said it cleared any payment still in progress, but only cleared
cookies: the old order stayed pending, its stock held and its PaymentIntent payable from
another tab. The route takes the cart id (the cart cookie — the same possession proof
the resume route accepts) and, if the order that cart became is still unpaid, cancels it
with the plain cancel (`customer_request`, by `shopper`): the held stock is released and
the intent is due for withdrawal at once. A payment that still lands is refunded at
settle. A cart with no order, or an order that is paid, expired or already cancelled, is
a no-op success. The reply says only whether an order was cancelled.
