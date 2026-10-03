---
"@otta-sh/plugin": minor
---

The order reads carry what the shopper's pages need to tell the truth (QA round 2,
X1–X3).

- **Place says which email the order has.** `storefront/checkout/place` answers with
  `buyerRefHint` (the order's email, masked: `j•••@g•••.com`) and `emailMatches`. A
  second checkout tab replays the order the first tab placed, and that order keeps the
  email it was placed with; `emailMatches: false` is how the site learns the typed email
  was not used. `CommerceClient.createOrder` carries the same pair
  (`buyerRefHint`, `buyerRefMatches`), compared trimmed and case-folded.
- **The public order read carries the refunded figure.** `PublicOrderWire` and
  `PublicOrderView` gain `refundedCents`: the sum of RECORDED refunds on the order's
  ledger, read in the same single ledger read as `latePayment` (the account read's
  rule). A refund made outside Otta ("Mark refunded") has no ledger row and stays 0.
- **The account's order read carries the delivery address and the tracking.**
  `AccountOrderWire` gains `shippingAddress` (the ship-to without its email and phone,
  or `null`) and `fulfillment` (carrier, tracking number, tracking URL, shipped-at — as
  the public read trims it). Only the owner's read has the address; the public read
  still omits it.
