---
"@otta-sh/plugin": minor
"@otta-sh/admin-react": minor
"@otta-sh/admin-presentation": minor
---

The admin order detail now shows "Prices include tax" under the totals when the order's
frozen tax snapshot recorded tax-inclusive prices (#421). An order with no snapshot, an
old-shape one, or one without the field shows nothing; the answer is never guessed from the
store's current settings. The order detail wire gains an optional `totals.pricesIncludeTax`.
