---
"@otta-sh/plugin": minor
---

**New `storefront/order/resume` route (`STOREFRONT_ORDER_RESUME_ROUTE`,
`OrderResumeRouteResult`)** and `CommerceClient.resumeOrderPayment(orderId, proof)`: a pending
order's payment, resumed from the order id plus a second factor (the order's cart, a session
that owns it, or its email); the id alone is `PROOF_REQUIRED`. It is the order page's "Complete
payment" on a device with no checkout stash. It replays the order's own checkout on its
own idempotency key, so it answers the SAME order and the SAME PaymentIntent, never a second
of either; it refuses `ORDER_NOT_PAYABLE` for anything but a `pending` order before its hold
deadline, without asking the provider. It also requires a SECOND FACTOR beside the id
(`ResumeProof`): the order's cart, a session whose customer owns the order, or the order's
email (compared trimmed and case-folded; `EMAIL_MISMATCH`; guesses `THROTTLED` per order through
`EmdashAttemptThrottle`). The id alone is `PROOF_REQUIRED`. The reply carries the order's email only as a hint
(`j•••@g•••.com`).

**BREAKING** for an out-of-tree `CommerceClient` implementation: `resumeOrderPayment` is a new
required method.
