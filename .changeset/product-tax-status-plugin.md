---
"@otta-sh/plugin": minor
"@otta-sh/admin-react": minor
"@otta-sh/admin-presentation": minor
---

Product tax status (Taxable / Shipping only / None) in both product editors, and a "Charge
tax on this method" toggle on the Shipping page (PR 2b). The product edit wire accepts
`taxStatus` (closed set, refused otherwise) and its idempotency key now covers it; the
product detail wire and `ShippingMethodWire` carry the new fields.
