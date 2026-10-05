---
"@otta-sh/plugin": patch
---

Retiring a coupon reads its dates with `parseCouponInstant`, the reader checkout uses, instead
of `Date.parse` (issue #364). `Date.parse` rolled an impossible date over (`2026-09-31` → 1
October) and read a zoneless date as server-local time, so retire could answer "already ended"
for a coupon checkout never read as ended. An unreadable expiry is now replaced with the retire
instant; an unreadable start is kept as stored.

**Before releasing:** coupons saved before the console checked dates on save may have bounds
checkout can't read, and checkout treats those coupons as not active. List them with the
read-only `packages/domain/scripts/scan-coupon-windows.ts` (usage in its header: export the
`coupons` collection with `wrangler d1 execute … --json` or `sqlite3 -json`, then
`node packages/domain/scripts/scan-coupon-windows.ts coupons.json`). It exits 1 when it finds
any; fix their dates or retire them.
