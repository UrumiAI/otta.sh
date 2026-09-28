---
"@otta-sh/domain": patch
"@otta-sh/plugin": minor
---

The storefront checkout prices shipping, tax and coupons (#305). `storefront/checkout/summary`
and `storefront/checkout/place` accept optional `shippingZoneId`, `shippingMethodId` and
`couponCode`, forwarded to the quote and to the order alike, so the review page states what
the order will charge. A coupon or method that does not apply comes back as its typed reason.
With a method and no zone, tax follows the method's zone instead of silently being zero.
