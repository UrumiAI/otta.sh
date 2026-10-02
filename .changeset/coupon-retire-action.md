---
"@otta-sh/plugin": minor
---

Coupons can be retired from the admin. A live or scheduled coupon's detail offers
**Retire coupon** (with a confirm), which ends it now: the rules surface's new
`retireCoupon` sets the expiry to the stores' own clock — the validity window checkout
already enforces — and drops a start date still in the future so the window is not left
inverted (instants are compared parsed, not as strings). It works on a redeemed coupon,
which delete cannot touch; uses and redemptions are unchanged; a shopper mid-checkout is
refused with the ordinary `COUPON_NOT_ACTIVE`. The success notice names the window it
replaced so a later expiry in Edit can reopen it. Retire re-reads before its
last-writer-wins write; an edit landing in that gap is lost, as documented on
`CouponStore.update`. The withheld-delete copy now points at Retire instead of "set its
expiry to a past date". No port or schema change.
