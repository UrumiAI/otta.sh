---
"@otta-sh/plugin": minor
---

Register an outside tax calculator (ADR-0030): a site's own plugin entry module exports
`createOttaPlugin({ taxCalculator })` and the descriptor's `entrypoint` points at it. The
default export keeps the built-in rate table. Quotes and orders made through the commerce
client use the registered calculator; when it fails, the quote and the checkout answer
the new `TAX_UNAVAILABLE` reason (`QuoteFailureReason`, `CheckoutFailureReason`) and no
order is placed. The calculator types are re-exported from `@otta-sh/plugin`.

The quote destination (`DestinationRequestWire`, and the checkout summary route's
`destination`) accepts an optional `postalCode` and `city`, bounded like the order
address, for calculators that price by address. Order placement passes the order
address's postcode and city to the calculator.
