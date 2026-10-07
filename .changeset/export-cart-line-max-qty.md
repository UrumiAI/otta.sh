---
"@otta-sh/plugin": patch
---

Export `CART_LINE_MAX_QTY` (10,000), the cart quantity cap the storefront routes
enforce, so a site can bound its quantity field to the same number and refuse an
over-cap quantity with copy that names the limit instead of a generic failure.
Additive; nothing else changes.
