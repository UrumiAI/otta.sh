---
"@otta-sh/admin-presentation": patch
"@otta-sh/admin-react": patch
---

The Orders search label says how it matches: "Search: #3F9A2, start of order ID or buyer
email, exact SKU" (the order number leads; see the order-number changeset). The id and email axes match a prefix (the port's guarantee, and all
the document store serves), so a domain-only fragment like `example.com` finds nothing —
QA read that as a broken search because the label never said so.
