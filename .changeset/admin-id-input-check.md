---
"@otta-sh/plugin": patch
---

The Shipping, Tax and Coupons create screens check a typed record ID before saving. An
ID with a space ("QA JP!") is refused on the create screen itself, with everything typed
put back and a suggestion ("The ID can't contain spaces — try "QA-JP!"."), instead of
reaching the commerce boundary and losing the draft. The rule is the boundary's own
`isIdToken`; only the words are the screen's.
