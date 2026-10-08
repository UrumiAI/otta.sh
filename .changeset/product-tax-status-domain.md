---
"@otta-sh/domain": minor
---

Product tax status and shipping-method taxable (ADR-0032 addendum, PR 2b).
`ProductCommerce.taxStatus` (`ProductTaxStatus`: `taxable` | `shipping_only` | `none`) is
new, set through `UpdateProductCommerceFieldsInput.taxStatus` only (the CMS-sync upsert has
no such field); `isProductTaxStatus` and `PRODUCT_TAX_STATUSES` are exported.
`ShippingMethod.taxable` is new (`CreateShippingMethodInput.taxable` defaults to `true`;
`UpdateShippingMethodInput.taxable` absent preserves). The built-in calculator taxes only
`taxable` lines and leaves the others out of at-subtotal rounding; an untaxed method is sent
as `shipping: null`; `validateTaxResult` refuses a non-zero tax on an untaxed line.
`PricedLine.taxStatus` and `TotalsLineInput.taxStatus` are new optional fields.
