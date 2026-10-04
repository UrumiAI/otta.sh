---
"@otta-sh/plugin": patch
---

Coupons console (QA round 2): a create that collides names WHICH half was taken — "The
coupon ID "c-five" is already used… the code is free", or "The code "X" is already used…"
— by looking the code up, and keeps the both-and-retry copy only when the same coupon
already exists or the lookup cannot answer. "Delete coupon" sits beside "Retire coupon"
on the coupon's main panel (never-redeemed coupons only, as before); the Redemptions
panel still says why a redeemed one cannot be deleted.
