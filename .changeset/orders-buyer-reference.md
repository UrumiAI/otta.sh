---
"@otta-sh/admin-presentation": patch
"@otta-sh/admin-react": patch
---

The Orders console now shows a readable buyer reference — an email address or
handle — instead of an opaque customer identifier. This applies to the Orders
list's Customer column, the order detail heading, and the refund confirmation
dialog, which prefers a verified account email when one is on file and falls
back to a generic phrase when no identity is available, never a blank or
truncated-looking value.
