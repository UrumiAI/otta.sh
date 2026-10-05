---
"@otta-sh/plugin": minor
---

Re-export `orderLabel`, `ORDER_LABEL_FALLBACK` and `OrderLabelLine` from
`@otta-sh/domain`, so a storefront that depends only on the plugin can name a
shopper's order by its products (`"Otta Tee and 2 more"`) instead of showing the
order id — the same function the order emails use, so the page and the email
cannot spell one order two ways.
