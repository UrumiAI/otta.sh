---
"@otta-sh/admin-presentation": patch
"@otta-sh/admin-react": patch
---

The Orders console now shows a readable buyer reference — an email address or
handle — instead of an opaque customer identifier, in the Orders list's
Customer column and the order detail heading; an absent reference still shows
as a dash, never blank. The refund confirmation dialog now names, in order, a
confirmed account email when one exists, otherwise the buyer reference
(visibly truncated with an ellipsis if very long), otherwise a generic
phrase — and the named recipient is now shown in quotes.
