---
"@otta-sh/domain": patch
---

`validateCoupon` compares a coupon's validity window as instants, not as strings, and
FAILS CLOSED on a bound it cannot read. String order is chronological only for
fixed-width `toISOString()` text, so a bound stored without milliseconds (`…12:00:00Z`) or
with an offset was judged up to a second (or hours) wrong. Bounds are now read by the new
`parseCouponInstant` — a zoned ISO-8601 date-time (`Z` or `±HH:MM`) naming a real calendar
date — and a non-null bound it cannot read (garbage, `2026-02-30`, or zoneless text that
`Date.parse` would read as host-local time) refuses the coupon with `COUPON_NOT_ACTIVE`,
as does an unreadable `now`. An unreadable bound never switches a coupon on.
