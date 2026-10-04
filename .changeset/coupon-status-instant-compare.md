---
"@otta-sh/plugin": patch
---

The Coupons console's computed status reads the validity window with the domain's
`parseCouponInstant`, matching checkout: a bound stored without milliseconds no longer
reads `scheduled` or `active` for up to a second too long, and a bound that cannot be read
shows a new `invalid` status (with a banner saying checkout refuses the code) instead of
`active`. The rules client now refuses a coupon `startsAt`/`expiresAt` that is not a zoned
ISO-8601 instant (`CommerceInputError`, wire max of 64 characters kept), and stores an
accepted bound in its canonical `toISOString()` form (`…13:00:00+01:00` is stored as
`…12:00:00.000Z`, ISO's `24:00` as the next midnight), so an untouched save never moves it.
**Operators:** coupons already stored with date-only or zoneless bounds (written through
the API before this release) will now show as `invalid` and be refused at checkout until
they are re-dated in Edit.
