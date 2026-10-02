---
"@otta-sh/plugin": minor
---

**The account order reads carry what the public order page shows** (QA U-5).
`OrderSummaryWire` (`listMyOrders`, `storefront/account/orders`) gains `createdAt` and,
on `totals`, `appliedCouponCode`, `shippingZoneId` and `shippingMethodId` — the same
evidence `PublicOrderWire.totals` carries of what the order was priced with. The
single-order read (`getMyOrder`, `storefront/account/order`) answers the new
`AccountOrderWire`: the summary plus `latePayment`, derived exactly as the public read
derives it. `orderTotalsFlags` is now exported and takes just the two snapshot ids, so a
storefront decides "Not calculated" by the order page's own rule.

**BREAKING** for an out-of-tree `CommerceClient` implementation: `listMyOrders` and
`getMyOrder` must return the new fields.
