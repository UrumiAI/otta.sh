---
"@otta-sh/plugin": patch
---

A refused input on a Block Kit admin screen (Shipping, Tax, Coupons) no longer reads
"Action outcome unknown — the action may already have been applied". The list/detail
scaffold now recognises `CommerceInputError` — which the commerce boundary throws before
anything is read or written — and renders "Not saved — check what you entered" naming the
field in words ("The ID can't contain spaces or control characters. Nothing was
changed."). Every other custom-action failure keeps the outcome-unknown warning.
