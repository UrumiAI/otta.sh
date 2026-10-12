# 0032. The store's tax options follow WooCommerce core, and an existing store keeps today's tax

- Status: proposed
- Date: 2026-10-07

## Context

ADR-0030 routed tax through one replaceable calculator. Merchants still could not set the
options every WooCommerce store has on its Tax tab: tax on or off, prices entered with or
without tax, what tax is based on, the shipping tax class, rounding, and how cart and
checkout show tax. WooCommerce's behaviour was verified from source (11.1.2,
`reports/global-tax/woo-facts-verified.md`): shipping costs are always entered without
tax; "shipping tax class based on cart items" counts only items that ship and are taxable
or shipping-only, prefers standard, then the single class, then the first class by NAME.

Existing Otta stores already charge tax from their rates, and choose the shipping tax class
as the class of the zone's last rate flagged "applies to shipping". What their customers
pay must not change silently (user decision 4).

## Decision

1. **A `tax` block in the operational settings** (`TaxSettings`): `enabled`,
   `pricesIncludeTax`, `basedOn` (`shipping` | `base`), `baseAddress` (country + region),
   `shippingTaxClass` (`inherit` | `legacy` | a fixed class), `roundAtSubtotal`,
   `displayCart` (`excl` | `incl`), `totalsDisplay` (`itemized` | `single`). It is stored
   whole in the settings singleton (no schema change on Postgres, D1 or sqlite: it is a
   document field) and validated by the `updateSettings` use-case. Billing address is not
   offered (decision 5): Otta holds none. A stored block with any field missing or
   wrong-typed (only a damaged document can have one: Otta writes it whole and
   normalised) reads as never saved, so the upgrade rule below decides — a store with
   rates keeps charging, rather than `enabled: "true"` reading as tax off.
2. **Defaults and the upgrade rule.** A new store gets WooCommerce's defaults: tax off,
   prices without tax, shipping address, based on cart items, per-line rounding, excl,
   itemized. With nothing saved, `effectiveTaxSettings` decides: any rate exists, or an
   outside calculator is registered (ADR-0030; it replaces the rates, so such a store has
   none) ⇒ `LEGACY_TAX_SETTINGS` (on, `legacy` shipping class, one "Tax" row: exactly
   today); neither ⇒ the new-store defaults. The quote and the admin apply the same rule. The first rate created, or the last deleted, on a store
   with nothing saved first writes its current options down, so adding or removing rates
   can never flip a store between the two. That write is conditional on nothing being
   saved, checked by the settings store atomically with the write (see 8), so it never
   overwrites an admin save that landed first. Tax off asks no calculator, outside ones
   included, as WooCommerce's integrations need "Enable taxes".
3. **Prices entered with tax** (all integer): a line's tax is the tax inside its
   discounted gross, `round_half_DOWN(G × r / (10000 + r))` — WooCommerce's rounding
   mode for tax-inclusive stores, which keeps `net + tax = gross` — and the total adds
   only the shipping tax. Prices without tax keep main's half-up rounding. `totals.tax` stays the whole tax; the snapshot's
   `pricesIncludeTax` tells readers. Shipping is always entered without tax. Buyers outside
   the base location pay the same gross (WooCommerce's adjustment is a follow-up).
4. **Rounding at subtotal**: as WooCommerce, the lines' exact taxes across all classes are
   summed and rounded once (half up; half down with tax-inclusive prices); the rounded total
   is split back to classes by largest remainder and within a class by amount, so the
   snapshot keeps per-line amounts that add up. Shipping tax always rounds half up on its own.
5. **Tax location**: `base` taxes at the shop's base address (falling back to the ship-to
   when none is set; the Tax options screen says so while that is the case). A cart with only digital goods is taxed at the base address when one
   is set, and stays untaxed, exactly as before, when none is. A location no zone matches
   gets no rate, so 0%, never a refusal.
6. **Shipping tax class.** `inherit` is WooCommerce's "based on cart items"; class
   names are ordered case-insensitively, as MySQL's default collation orders them, with
   names equal but for case going to the lower id. A `fixed` class cannot be deleted while
   the options name it (`in_use_by_settings`). If it is missing anyway (a damaged document,
   or a delete that raced the save), the built-in falls back to `inherit` — not to
   `legacy`, whose last-flagged-rate rule is a pre-2a store's and can tax shipping in a
   class no item in the cart has. `inherit` taxes shipping whenever a shipping line's
   class has a flagged rate, so a missing class never silently untaxes shipping.
7. **Display**: the quote reply carries the tax per label and the display options; the
   checkout shows prices with or without tax and the tax itemized or as one row, every row
   still summing to the total. Labels are merchant or calculator text and are rendered only
   as escaped text. A store with tax off, or with nothing saved, renders exactly as before.
8. **Admin**: a "Tax options" drill-in on the Tax page; a save is guarded on the value the
   form loaded (a compare like the tax rate's `expectedRateBps`, ABA accepted the same
   way). The guard is atomic: the save is written with `SettingsStore.update(…, { ifTax })`,
   which the store checks against the very state each compare-and-set attempt replaces, so
   a concurrent change — another save, or a first-rate pin — makes it `stale` rather than
   being overwritten. The Tax pages show a "tax is switched off" banner when the store has
   rates but tax is off.

## Consequences

- Parity is checked against an independent WooCommerce 11.1.2 answer key
  (`test/pricing/woo-oracle-parity.test.ts`, 37 in-scope scenarios of 39 since PR 2b; the
  two skipped are shop-page display). Two divergences remain, by
  choice: **RD-07** — rounding at subtotal, WooCommerce rounds the grand total once from
  unrounded parts (725) while its tax total says 120; Otta keeps
  `subtotal − discount + shipping + tax = total` exact (724). **Coupon cents** — Otta
  allocates a coupon pro rata over line subtotals (unchanged); WooCommerce splits a fixed
  cart coupon equally per unit and gives the leftover cents to the highest unit price first
  (EX-08: WooCommerce discounts 334/666, Otta 500/500, a 166-cent gap per line; tax 247 and
  total 3247 against Otta's 248 and 3248). Kept by decision (issue #424, addendum below).

- No existing store's charges change: the domain and plugin goldens keep every money
  figure (the INR case's shipping tax stays 882). They gain `requiresShipping` on quote
  lines; rate-less stores' snapshots record `otta.tax-disabled`.
- An order taxed at the shop base address with no shipping zone (a digital-only cart) records
  `located: true` on its v1 tax snapshot, so its pages and emails show the tax charged rather
  than "Not calculated". So does an order whose outside calculator (ADR-0030) charged tax
  without any shipping zone matching (#436): `located` means a place resolved to a zone, or
  tax was charged. v1 snapshots written without the field read as not located (the
  shipping-zone rule, as before); the version stays 1 because the field is optional.
- With prices shown the other way from how they were entered and a coupon applied, the
  subtotal and discount split the line tax pro rata, because tax is known only on the
  discounted lines; the rows still sum exactly.
- A site that registered an outside calculator (ADR-0030) on a store with no rates and
  nothing saved keeps charging through it: the registration counts as "already charges
  tax". Saving tax off afterwards switches it off, as for any store.
- An outside calculator's answer is bounded by the 1000% rate cap: `amount × 10` for an
  amount entered without tax and for shipping; for a line entered with tax, the tax inside
  the gross at that rate, `ceil(G × 100000 / 110000)`, so the net can never go negative.
- Built since: the checkout and order pages hide the Tax row when tax is off (#420); the emails still show it (follow-up).
- Built since: shop-page price display (#477), cart-page line prices (#477), per-line prices
  with/without tax on the review table (#477, `showCheckoutLinesTax`), finer rate precision
  (#475), buyer-location tax for digital goods (#467), itemized tax rows on the order pages,
  the emails and the admin order detail (#469), the admin order detail's "Prices included tax"
  marker (#461), and each line's tax status in the frozen order tax snapshot (#466).
- Follow-ups, not built: postcode/city matching, priority/compound rates, CSV;
  customer tax-exempt; adjusting inclusive prices for non-base buyers.

## Addendum (PR 2b): product tax status and shipping-method taxable

- **Product tax status** — `ProductCommerce.taxStatus`: `taxable` | `shipping_only` |
  `none`, WooCommerce's `tax_status`. Set in admin only (both product editors), like
  `inventoryPolicy`; the CMS sync never writes it. A product stored before the field reads
  `taxable`, with no migration. Only a `taxable` line is taxed by the built-in: the others
  get 0 (display rate 0) and are left out of the at-subtotal class groups, so they never
  absorb an allocated cent; with prices entered with tax their gross is their net.
- For "based on cart items", `taxable` and `shipping_only` lines that ship count; `none`
  and digital lines do not (WooCommerce `is_shipping_taxable`). "Shipping only" is allowed
  on a digital product and behaves like "None" there. A fixed class ignores the items; the
  `legacy` rule is unchanged, so a legacy store still taxes shipping on an all-`none` cart.
- **Method taxable** — `ShippingMethod.taxable` (default `true`; an older method reads
  `true`), a toggle on the Shipping page. An untaxed method is sent to the calculator as
  `shipping: null`, in every shipping-tax-class mode.
- **Outside calculators** — a non-zero tax on a `shipping_only`/`none` line, or on shipping
  that was not asked about, is refused (`TAX_UNAVAILABLE`), never silently zeroed. The rule
  also holds for the built-in.
- The quote command carries a line's `taxStatus` only when it is not `taxable`, so every
  existing golden is byte-identical. The order tax snapshot's shape is unchanged.
- The admin product edit's idempotency key covers the tax status, so two saves at one
  watermark that differ only in status are never one replay.

## Addendum (2026-10-09, issue #424): coupon cent allocation stays pro rata

Decided by the maintainer: Otta does not add WooCommerce's coupon allocation, not even as an option.

- **Difference.** WooCommerce splits a fixed cart coupon equally per unit (an integer amount per unit), then gives the leftover cents to the highest unit price first. Otta takes the discounted subtotal and splits it over the line subtotals pro rata by largest remainder (`allocateCents`). In EX-08 (fixed 1000 over 2000 + 2x1000) WooCommerce discounts the lines 334/666 and Otta 500/500: each line differs by 166 cents. The tax follows. Both lines are taxed at 8.25% on their discounted amounts, so Otta gets 124 + 124 = 248 tax and a 3248 total, WooCommerce 137 + 110 = 247 and 3247.
- **Why Otta keeps it.** A line's share of the coupon is its share of the cart's value, whatever its unit count: a line of one 2000 item and a line of two 1000 items take the same discount. The rule predates the tax work (#416 left it unchanged), and keeping it was a maintainer decision. (Exact sums and a deterministic result also hold for WooCommerce, so they are not reasons to differ.)
- **Cost.** A merchant comparing per-line discount or tax with WooCommerce can see differences of tens or hundreds of cents per line with odd amounts, and a cent or more in the tax total and the order total.
- **Pinned** by the EX-08 test in `packages/domain/test/pricing/woo-oracle-parity.test.ts`, which runs `computeTotals` and asserts Otta's 500/500, 248 and 3248 against WooCommerce's 334/666, 247 and 3247 from the oracle. Changing the rule must change that test on purpose.

## Addendum (#426): tax based on the customer's billing address, for digital-only carts

- `basedOn` gains `billing` — WooCommerce's "Customer billing address"
  (`woocommerce_tax_based_on` = `billing`), which reverses decision 5's "billing address is
  not offered". No store gets it unless an admin saves it: the defaults and the upgrade rule
  are unchanged, so every existing store keeps today's behaviour exactly.
- Otta collects a billing LOCATION (country and optional region code), and only for a cart
  that ships nothing — the checkout's existing zero-JS "where" block, shown with no delivery
  options. Under `billing` such a cart is taxed at that location; with none given it falls
  back to the base address (decision 5, as before). The location is the buyer's own
  declaration, not verified evidence: a buyer can pick a country taxed at 0%, as in WooCommerce (the options screen says so). A location no zone matches gets 0%, never a refusal; a
  malformed one is refused with the ship-to's reasons, and so is a location without a region
  in a country whose zones go down to regions (ES with ES-CN zoned apart, CA/QC, US states):
  `SHIPPING_REGION_CODE_REQUIRED`, exactly as for a ship-to, never a silent 0%. A cart that ships
  is still taxed by its ship-to, its only address (WooCommerce's checkout likewise bills to
  the ship-to unless told otherwise). Under `shipping` or `base` the location is ignored
  entirely — never validated, never priced by.
- The review quote and the order are taxed at the same location by convention: the review
  prices the location the page sent (`destination`, for a cart that ships nothing), and the
  place form echoes it as the order's `billingLocation`; the domain re-prices the order from
  what it is sent. A buyer address sent for another reason (issue
  #382) is not used as the billing location, because the review was not priced for it.
- The order's v1 tax snapshot gains an optional `taxAddress: { basis, country, region }`,
  written on every order priced under `billing` whose tax had an address: `billing` (the
  buyer's declared location), `base` (a digital cart whose buyer gave none) or `shipping` (a
  cart that ships). Orders under `shipping` or `base` are snapshotted exactly as before, and
  older snapshots read without it. The admin order detail states it ("Tax location: DE
  (buyer-declared)").

## Addendum (#423): shop-page price display

- **The option.** `tax.displayShop`, WooCommerce's `woocommerce_tax_display_shop`, is optional
  and takes `excl` or `incl`. When it is absent, prices show as entered. That is a third
  value WooCommerce does not have. It is the default for both default blocks and for every
  block saved before the option existed, so no store's pages change until the merchant
  picks a value. A stored block without the key is not damaged: `readTaxSettings` keeps it.
  The settings digest and `sameTaxSettings` add the field only when it is set, so a block
  without it keeps its old fingerprint.
- **The maths** is checkout's: `shopDisplayPrice` runs one line through `applyRateTable`
  (per-line or at-subtotal rounding, half up without tax, half down for the tax inside a
  gross price). There is no second formula. Oracle rows DP-01 and DP-02 are now in scope,
  so all 39 rows run.
- **Where.** Prices are taxed at the shop base address's zone, which is WooCommerce's
  default location for a shopper whose address is unknown. The rates follow each product's
  tax class, and only `taxable` products carry tax. A base address that no zone matches
  gets 0%.
- **When the stored price is shown**: tax off; no base address; or an outside calculator
  registered (ADR-0030). An outside calculator is asked once per quote with a real cart.
  It is never asked once per product on a listing render, because that would put a paid,
  rate-limited and possibly slow outside call on every page view.
- **What is affected.** The PDP and PLP price and the PDP was-price use the shown figure.
  The view model's `price.taxNote` (`incl`/`excl`) is present only then, so the theme prints
  "incl. tax" or "excl. tax" only for a store that opted in. If the display read fails, the
  page falls back to prices as entered and logs a warning; the page never fails.
- **JSON-LD.** The PDP offer carries the shown figure. When the display is `incl`, the offer
  price always includes VAT, which is what search engines expect for consumer prices in
  VAT regions. When it is `excl`, the offer carries the price without tax, matching the page
  (Google asks that structured data match the visible price). As entered, the offer is the
  stored price, as before.
- **Cart and checkout lines (review round 1).** These follow `displayCart`, WooCommerce's
  `tax_display_cart`, not just the totals rows.
  - The cart page has no address yet. It prices lines at the shop base address with
    `shopDisplayPrice`, and its total is the sum of the shown lines.
  - The checkout review uses the quote's own per-line tax (`QuoteTaxWire.lineTaxes`). It
    splits the amount the subtotal row moves by across the lines by their tax, using
    largest remainder, so the lines always sum to the shown subtotal. Without a coupon,
    that is each line's own tax.
  - A unit price is the line's share divided by the quantity, rounded the way the tax is
    rounded: half down for prices entered with tax, half up otherwise. This is exact at
    quantity 1. As in WooCommerce, unit × quantity can differ from the line by a cent.
  - With an outside calculator registered (ADR-0030), checkout lines still follow the
    quote's per-line tax, which is that calculator's answer. The cart page shows those
    stores' prices as entered, because it never calls the calculator.
  - A store whose `displayCart` matches how its prices are entered (every default store),
    or whose tax is off, renders its lines byte for byte as before.
  - Placed-order pages and emails read the order's line snapshot, which records no
    per-line tax, so their lines are unchanged.
- What is charged (the quote and the order) is unchanged.
