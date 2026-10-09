# 0033. One currency table decides each currency's minor unit

- Status: accepted
- Date: 2026-10-08
- Relates to: DEVELOPMENT.md §4 (money is integer minor units),
  [ADR-0012](./0012-storefront-checkout-loads-stripe-elements-in-the-browser.md) (Stripe live
  path), PR #438.
- Numbered 0033 because 0031 is the email ADR and 0032 the tax-options ADR.

## Context

Money was "integer minor units", but every admin money input assumed hundredths: a JPY price
typed `1500` was stored as 150000 and shown as ¥150,000, while display took each currency's
exponent from ICU. Stripe's live path refused every zero- and three-decimal currency to hide
the mismatch. In effect, only two-decimal currencies worked.

## Decision

1. **One table is the source of truth for minor-unit digits**:
   `packages/domain/src/money/currencies.ts` (code, ISO 4217 digits, English name). It is
   mirrored in `packages/admin-presentation/src/currencies.ts`, because the admin may not
   import the domain, and a parity test pins the two tables identical. Digits follow **ISO 4217,
   not CLDR**: where ICU disagrees (COP, HUF, IDR, PKR: ICU 0, ISO 2) the table wins, and a test
   lists each divergence.
2. **Input, display and Stripe all read the table** for a listed code. Money inputs accept up
   to the currency's digits (JPY whole units, KWD thousandths). `formatMoney` shows exactly
   those digits. Stripe receives the stored integer unchanged, which is Stripe's `amount` for
   two- and zero-decimal currencies.
3. **A code outside the table keeps the behaviour it had before**: input in hundredths, display
   at ICU's exponent, Stripe's old zero- and three-decimal refusals. Stored rows in any
   shape-valid code still load. Membership is enforced only where a merchant authors a
   currency on the admin screens (a product's first price, a new shipping rate or coupon).
4. **ISK is excluded.** ISO gives it 0 digits, but Stripe takes it as a two-decimal amount, and
   every ISK amount written before this change is stored in hundredths. Listing it would
   silently re-read those integers and needs a data migration first. UGX is excluded for the
   same Stripe reason.
5. **Three-decimal currencies (BHD, JOD, KWD, OMR) are refused at Stripe.** Stripe wants their
   amounts in multiples of 10, and an order total need not be one. Rounding money is a
   separate decision. They stay priceable and displayable, and the admin warns that they
   cannot be charged through Stripe yet. *Superseded by the amendment below.*
6. **A percentage coupon's cap and minimum spend are bound to a currency.** They are amounts,
   so setting either requires a currency. The coupon then applies only to carts in that
   currency, and stays bound once both are cleared. A currency is accepted only together
   with a bound. An edit names the currency it parsed in, and the store checks it inside its
   compare-and-set. Percentage coupons whose bounds predate this keep their old behaviour
   (hundredths, any cart).

## Consequences

- Adding a currency is one row in each of the two tables, guarded by the parity, ICU and
  Stripe every-row tests.
- Upgrade: JPY/KRW/VND/CLP amounts typed earlier were stored ×100 and become chargeable at that
  value (DEPLOYMENT.md). HUF/IDR/COP/PKR display gains its two decimals.
- A store-wide currency setting and three-decimal Stripe charges are follow-ups.

## Amendment (2026-10-09): three-decimal currencies are payable — the final total is rounded

Decision 5 is replaced. BHD, JOD, KWD and OMR are payable at checkout.

1. **The table names a payment increment.** A row may carry `paymentIncrement` (minor units):
   the smallest amount a payment in that currency can be. The four three-decimal rows carry
   10 (0.010); every other row has none, meaning any minor-unit amount. The admin mirror
   carries the same field and the parity test compares it. The name is vendor-neutral; the
   Stripe adapter's tests pin it equal to Stripe's own step for every row.
2. **Only the final total is rounded.** After tax, `assembleTotals` rounds the total half-up
   to the increment (`roundHalfUpToMultiple`, BigInt) and records the difference as a signed
   `roundingCents` (`SignedCents`, a separate brand: `Cents` stays non-negative). Line
   prices, discounts, shipping and tax stay exact. `|rounding| ≤ increment / 2`, and
   `subtotal − discount + shipping + tax + rounding = total` (with tax-inclusive prices, the
   shipping tax alone is added, as before). This is cash rounding, as Swiss and Nordic
   receipts do it.
3. **The field exists only where it applies.** `roundingCents` is present on a quote or order
   in an increment currency (0 when the exact total was already a multiple), and absent for
   every other currency, so their quotes, orders, wires, emails, Stripe requests and reports
   are byte-identical to before. The order's totals snapshot stores it as an optional
   `rounding`; an order written before it has none and reads as 0.
4. **The rounded total is the charged total.** The payment intent asks for it, settlement
   compares the payment with it, and revenue reports sum it. Pages, emails and the admin's
   order detail show a "Rounding" row, signed (`−KWD 0.004`), only when it is non-zero.
5. **Refunds are multiples of the increment**, or the whole remaining amount (an order placed
   before this change may hold any remainder). The admin's refund form and its server action
   refuse anything else. The Stripe adapter also refuses, before any network call, an intent
   (`unsupported_amount`) or refund (`TERMINAL`) whose amount is not a multiple of 10 in
   Stripe's three-decimal set. It never rounds.
6. **The "not yet payable" machinery is removed**: `isCheckoutPayableCurrency`,
   `StoreCurrencyNotPayableError`, `checkoutPaymentWarning` and its label helpers. No listed
   currency is unpayable now. A future currency with a payment rule gets an increment, not a
   refusal. TND, which Stripe also takes in steps of 10, is not in the table and keeps its
   unlisted-code refusal.
