---
"@otta-sh/plugin": minor
---

**New `storefront/order/resume` route (`STOREFRONT_ORDER_RESUME_ROUTE`,
`OrderResumeRouteResult`)** and `CommerceClient.resumeOrderPayment(orderId)`: a pending
order's payment, resumed from the order id alone — the order page's "Complete payment" on a
device with no cart cookie and no checkout stash. It replays the order's own checkout on its
own idempotency key, so it answers the SAME order and the SAME PaymentIntent, never a second
of either; it refuses `ORDER_NOT_PAYABLE` for anything but a `pending` order before its hold
deadline, without asking the provider. The reply carries the order's email only as a hint
(`j•••@g•••.com`).

**BREAKING** for an out-of-tree `CommerceClient` implementation: `resumeOrderPayment` is a new
required method.
