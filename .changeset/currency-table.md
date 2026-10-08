---
"@otta-sh/domain": minor
"@otta-sh/admin-presentation": minor
"@otta-sh/plugin": minor
"@otta-sh/payments-stripe": minor
"@otta-sh/admin-react": minor
---

Price in 50 currencies, each in its own minor unit, from one currency table.

- **One table.** `@otta-sh/domain` exports `SUPPORTED_CURRENCIES` (code, ISO 4217 digits,
  symbol, name — USD, EUR, GBP, JPY, INR, … KWD, ISK), `isSupportedCurrency`, `currencyDigits`,
  `currencyInfo` and the `SupportedCurrencyCode` type, from `src/money/currencies.ts`, whose
  header says how to add a currency. `@otta-sh/admin-presentation` carries an identical copy
  (plus `minorUnitDigits`), pinned row-for-row by a parity test. A test compares every row's
  exponent with ICU, with a commented list of the ISO-vs-CLDR divergences (COP, HUF, IDR, PKR:
  the table follows ISO's 2).
- **Money inputs follow the currency (the bug).** `parseMinorUnitsInput(input, currency, opts)`,
  `formatMinorUnitsInput(minor, currency)` and `canonicalMoneyInput(input, currency)` now take
  the currency (BREAKING signature change) and read up to its digits: JPY `"1500"` is 1500, not
  150000; KWD `"1.234"` is 1234. Two-decimal currencies parse and format exactly as before.
  Product price, compare-at and cost; shipping rate and threshold; fixed coupon amount and
  minimum spend (percentage-coupon caps keep hundredths); the React pricing cards and the
  refund amount all pass their currency. Refusal copy names the currency's own precision.
- **Display reads the same table.** `formatMoney`, `majorUnits` and the provider-refund flag
  use the table's digits for a listed code (ICU's for any other code, as before). Output is
  unchanged wherever ICU agrees; for HUF/IDR/COP/PKR it now shows the two ISO decimals instead
  of rounding them away.
- **Supported set at the admin's write boundary.** A new shipping rate's or coupon's currency
  and a product's first price currency must be in the table ("XYZ isn't a supported currency");
  this replaces the ISO membership list (`CURRENCY_CODES` / `isIsoCurrencyCode` are removed).
  Stored rows in any shape-valid code still load, render and — for a product already priced in
  one — stay editable.
- **Stripe maps amounts per currency** (`stripeAmountFactor`, from docs.stripe.com/currencies):
  two- and zero-decimal currencies (JPY, KRW, VND, CLP) are sent unchanged and now go live; ISK
  is sent ×100 and read back ÷100 (intent, webhook, refund pre-flight and refund);
  three-decimal currencies (KWD, BHD, OMR, JOD) are still refused with `unsupported_currency`,
  and refunds in a refused currency are `TERMINAL` before any call. A code outside the table is
  treated as before. `STRIPE_UNSUPPORTED_CURRENCIES` is replaced by
  `STRIPE_ZERO_DECIMAL_CURRENCIES`, `STRIPE_THREE_DECIMAL_CURRENCIES`,
  `STRIPE_HUNDREDFOLD_CURRENCIES`, `stripeAmountFactor` and `fromStripeAmount`.
- **React console.** The first-pricing currency picker offers every table currency (the
  familiar ten first, labelled `USD — US Dollar`); USD stays the default.
