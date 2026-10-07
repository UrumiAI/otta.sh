---
"@otta-sh/plugin": patch
---

Coupons list: a computed `Status` column and a `Min spend` money column, and
the `∞` glyph retired from `Uses`.

`Status` reads `active` / `scheduled` / `expired` / `used up`, DERIVED at
render from the coupon's own `startsAt` / `expiresAt` / `usesCount` / `maxUses`
— it is not a stored field and gets no form input anywhere (a value the domain
decides is displayed, never given a second, disagreeing home). The new
`couponStatus(coupon, now)` mirrors the domain's `validateCoupon` check for
check, including its half-open `[startsAt, expiresAt)` window, so a coupon
whose expiry is exactly `now` reads `expired` at the same instant checkout
starts refusing it, and a coupon that is both exhausted and expired reads
`expired` — the reason checkout would give. `now` is passed in, one instant per
response, so no two rows of a table can be judged against different clocks.
Before this, `EXPIRED20` (ended a month ago) and `LAUNCH2026` (starts in two
weeks) rendered identically to a live coupon, and the only signal was raw date
text an operator had to do arithmetic on, row by row, on a screen whose whole
purpose is "which discounts are live right now".

`Status` renders as PLAIN TEXT rather than badging the exceptions, which is a
constraint, not a preference: Block Kit's `format` is a property of the COLUMN,
not of a cell, so a table badges every row of a column or none of them, and
emptying the happy-path cell to fake the split still draws the pill — just
without a word in it. Given all-or-nothing, none wins: a pill on every live
coupon spends the heaviest ink on the least informative value. Badging only
the exceptions needs per-value control the renderer does not have.

`Min spend` renders the coupon's minimum cart subtotal through `formatMoney` in
the coupon's own currency and sits LAST, after every non-money column. An
ABSENT minimum is `—`, never `$0.00` and never "Free": "no floor" and "a floor
of nothing" are different claims. The currency rides in the formatted value
rather than a header suffix — coupons genuinely mix currencies across rows, so
`Min spend (USD)` would be a lie the first time a EUR coupon lands — and a
percentage coupon, which carries no currency at all, renders its floor as the
same plain exact decimal its cap already does.

`Uses` now reads `1 of 500` / `0 uses` instead of `1 / 500` / `0 / ∞`, in the
list column, the "Open coupon" picker label and the detail's identity strip
alike. `∞` is a glyph, not a word: it does not localize, and `N of M` is
already how this screen's own Redemptions meter reads.
