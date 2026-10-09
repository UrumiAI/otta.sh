---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": minor
"@otta-sh/admin-presentation": minor
"@otta-sh/admin-react": minor
"@otta-sh/payments-stripe": minor
---

Three-decimal currencies (BHD, JOD, KWD, OMR) are payable at checkout (ADR-0033 amendment).
The currency table gains an optional `paymentIncrement` (10 for those four; mirrored in
`@otta-sh/admin-presentation`, read through `currencyPaymentIncrement`). For such a currency
the totals pipeline rounds only the FINAL total half-up to the increment and records the signed
difference as `TotalsBreakdown.roundingCents` (new `SignedCents` brand, `signedCents()`); line
prices, discounts, shipping and tax stay exact. Orders persist it as an optional
`OrderTotals.rounding`; orders written before it carry none (= 0). The quote and order wires
carry `roundingCents` only when the order has one; the checkout view model adds an optional
`rounding` row (signed, only when non-zero, and held back on a live quote while shipping or
tax is uncalculated), and the order emails, the staging site's
checkout and order pages and the admin order detail show "Rounding". Every other currency is
unchanged: no field, no row, the same totals, emails and Stripe requests.

Refunds in these currencies must be multiples of 0.010 or the whole remaining amount:
`refundOrder` refuses anything else with `AMOUNT_NOT_PAYMENT_INCREMENT` (an amount over the
remainder is still `REFUND_EXCEEDS_*`), which the admin words with the currency's step; the
React refund form checks the same first (`isRefundableIncrement`, `refundIncrementText`).
`payableTotal` and `roundingEntry` are the one rounding and the one presence rule.

The Stripe adapter now charges the four codes (amounts sent unchanged), and refuses before any network call an intent (`unsupported_amount`) or refund
(`TERMINAL`) not a multiple of 10 in Stripe's three-decimal set (`stripeAmountIncrement`).

The Settings store-currency select offers every listed currency, these four included.
