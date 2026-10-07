---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": minor
---

Coupon codes match case-insensitively at checkout. `CouponStore.findByCode` now folds
case, so a shopper typing `save5` gets the merchant's `SAVE5`. Codes were already unique
after case folding in the document store and the admin search was already
case-insensitive, so checkout was the one place the rule split — QA found the console
describing one behaviour and checkout applying the other. The applied code (and the
order's snapshot) keeps the merchant's own spelling. The in-memory store now refuses a
code that differs from a live coupon's only in case, matching the document store.
Behaviour change for API callers: a lower-cased code that used to be `COUPON_NOT_FOUND`
now applies.
