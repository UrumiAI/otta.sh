---
"@otta-sh/domain": minor
"@otta-sh/admin-presentation": minor
"@otta-sh/plugin": minor
"@otta-sh/payments-stripe": minor
"@otta-sh/admin-react": minor
"@otta-sh/store-emdash": patch
---

Price in 49 currencies, each in its own minor unit, from one currency table.

- **One table.** `@otta-sh/domain` exports `SUPPORTED_CURRENCIES` (code, ISO 4217 digits,
  English name — USD, EUR, GBP, JPY, INR, … KWD), `isSupportedCurrency`, `currencyDigits` and
  the `SupportedCurrencyCode` type, from `src/money/currencies.ts`, whose header says how to
  add a currency. `@otta-sh/admin-presentation` carries an identical copy (plus
  `minorUnitDigits` for display and `inputMinorUnitDigits` for input), pinned row-for-row by
  a parity test. A test compares every row's exponent with ICU, with a commented list of the
  ISO-vs-CLDR divergences (COP, HUF, IDR, PKR: the table follows ISO's 2). ISK is
  deliberately not listed: its stored amounts are hundredths.
- **Money inputs follow the currency (the bug).** `parseMinorUnitsInput(input, currency, opts)`,
  `formatMinorUnitsInput(minor, currency)` and `canonicalMoneyInput(input, currency)` now take
  the currency (BREAKING signature change; `NO_CURRENCY` names an amount with none) and read
  up to its digits: JPY `"1500"` is 1500, not 150000; KWD `"1.234"` is 1234. Two-decimal
  currencies, and every code outside the table, parse and format exactly as before
  (hundredths). Product prices, shipping rates and thresholds, coupon amounts, caps and
  minimum spends, the React pricing cards and the refund amount all pass their currency;
  `moneyInputExample` gives refusal copy an example in the currency's own shape.
- **Display reads the same table.** `formatMoney`, `majorUnits` and the provider-refund flag
  use the table's digits for a listed code (ICU's for any other code, as before). Output is
  unchanged wherever ICU agrees; HUF/IDR/COP/PKR now show their two ISO decimals.
- **Supported set at the admin's write boundary.** A new shipping rate's or coupon's currency
  and a product's first price currency must be in the table ("XYZ isn't a supported
  currency"); this replaces the ISO membership list (`CURRENCY_CODES` / `isIsoCurrencyCode`
  are removed). Programmatic writes check only the shape. Stored rows in any shape-valid code
  still load, render and — for a product already priced in one — stay editable.
- **Percentage coupons bind their bounds to a currency.** A NEW cap or minimum spend on a
  percentage coupon requires a currency (create form, or once on edit for a coupon with none;
  `CouponEdit.currency`, `UpdateCouponInput.bindCurrency`); the coupon then applies only to
  carts in it, refused with `COUPON_CURRENCY_MISMATCH` like a fixed-amount coupon. A currency
  is accepted on a percentage coupon only WITH a cap or minimum spend, and a bound coupon stays
  bound once they are cleared. A percentage coupon with a cap or minimum and no currency,
  written earlier, behaves exactly as before (and cannot be bound). Coupon edits parse amounts in
  the currency the form was rendered with and send it back; the rules client refuses (409) an
  edit whose coupon's currency changed meanwhile, rather than re-reading it. The check runs inside the store's
  compare-and-set (`UpdateCouponInput.expectCurrency`, refusal `currency_moved`), so a bind
  racing an edit can never land the edit's amounts in the other currency.
- **Coupon refusal order.** `validateCoupon` now checks the coupon's currency BEFORE its
  minimum spend and use limit, so a coupon in another currency is reported as
  `COUPON_CURRENCY_MISMATCH` rather than `COUPON_MIN_SUBTOTAL` / `COUPON_EXHAUSTED` (fixed and
  bound percentage coupons alike).
- **Stripe charges zero-decimal currencies.** `STRIPE_UNSUPPORTED_CURRENCIES` is replaced by
  `stripeRefusesCurrency` (plus `STRIPE_ZERO_DECIMAL_CURRENCIES` /
  `STRIPE_THREE_DECIMAL_CURRENCIES`): amounts still go out unchanged, and JPY, KRW, VND and CLP
  now go live (whole units are Stripe's amount); a code outside the table is treated as before.
  Three-decimal currencies are charged too — see the three-decimal rounding changeset.
- **React console.** The first-pricing currency picker offers every table currency (the
  familiar ten first, labelled `USD — US Dollar`); USD stays the default.
- **Display digits.** The domain now exports `minorUnitDigits` (display digits: table → ICU →
  2); `formatMoney` caches its formatters per locale and currency. See ADR-0033.

**Upgrade notes.** JPY/KRW/VND/CLP amounts typed in the admin on an earlier version were stored
×100 and become purchasable at that stored value — check and re-enter them before upgrading.
HUF/IDR/COP/PKR now display at ISO's two decimals. Currency membership is enforced on the admin
screens only. See DEPLOYMENT.md.
