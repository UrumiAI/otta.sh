---
"@otta-sh/plugin": minor
---

Coupons can be retired from the admin. A live or scheduled coupon's detail now offers
**Retire coupon** (with a confirm), which ends it now by setting its expiry to the current
instant — the validity window checkout already enforces — and drops a start date still in
the future so the window is not left inverted. It works on a redeemed coupon, which delete
cannot touch; uses and redemptions are unchanged, and a later expiry in Edit reopens it.
The withheld-delete copy now points at it instead of "set its expiry to a past date".
No port or schema change.
