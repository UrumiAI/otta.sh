---
"@otta-sh/admin-presentation": patch
"@otta-sh/admin-react": patch
---

The Orders search label says how it matches: "Search by start of order ID or buyer
email, or exact SKU". The id and email axes match a prefix (the port's guarantee, and all
the document store serves), so a domain-only fragment like `example.com` finds nothing —
QA read that as a broken search because the label never said so.
