---
"@otta-sh/domain": patch
"@otta-sh/payments-stripe": patch
"@otta-sh/payments-x402": patch
"@otta-sh/plugin": patch
"@otta-sh/service": patch
"@otta-sh/store-postgres": patch
---

Rebrand Urumi to Otta. The npm scope is now `@otta-sh/*` (was `@urumi/*`).

Nothing had been published to npm under the old scope, so there is no
deprecation path to follow and no redirect to install — this rename only had
to land before the first publish, and it did.

Consumers of the workspace should update their import specifiers. The EmDash
plugin id is now `otta` and its product-data widget id is `otta:product-data`;
sites that registered the plugin under the old id must update their descriptor
and re-seed (or hand-edit) the `products` collection schema. The storefront
cookies are now `otta_cart` and `otta_session`, so carts and customer sessions
issued under the old names are not carried over.
