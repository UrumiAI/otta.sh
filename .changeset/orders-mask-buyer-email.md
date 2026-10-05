---
"@otta-sh/admin-presentation": minor
"@otta-sh/admin-react": minor
"@otta-sh/plugin": patch
---

The Orders console now masks buyer email addresses by default — `jane.doe@gmail.com`
shows as `j•••@g•••.com`, the same hint the checkout resume page already uses — in the
Orders list's Customer column, the order detail heading, its Customer and Shipping
address groups, and the refund confirmation. A Show button beside each list row, and a
Show email button on the order detail, reveals the full address; Hide masks it again.
Revealing is not remembered, and a masked address is not in the page at all until it is
revealed. Anything containing `@` is treated as an address: one that is not cleanly
formed shows as `j•••@•••`. A buyer reference with no `@` is shown as before. Searching
by email is unchanged.

`@otta-sh/admin-presentation` now exports `buyerRefHint` (moved from `@otta-sh/plugin`,
which re-exports it unchanged) and `maskBuyerEmail`.
