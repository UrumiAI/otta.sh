---
"@otta-sh/store-emdash": patch
"@otta-sh/domain": patch
---

A coupon create refused on its ID no longer releases the existing coupon's code. A
double-submitted create (the same ID and code) found the code claim already held by that
ID, then — on the ID collision — gave the claim back, so the live coupon stopped being
found by its code at checkout and in the admin search. The store now releases only a
claim the refused call itself wrote. Pinned in `couponStoreContract` (found while fixing
QA round 2's duplicate-coupon message).
