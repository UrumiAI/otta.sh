---
"@otta-sh/plugin": patch
---

A new coupon code may not contain spaces. The Coupons create screen refuses `QA ADMIN`
on the create screen with the draft kept and a suggestion (`QA-ADMIN`), and the rules
client refuses it too (`CommerceInputError` on `code`). Coupons created before the rule
keep working as issued — codes are immutable.
