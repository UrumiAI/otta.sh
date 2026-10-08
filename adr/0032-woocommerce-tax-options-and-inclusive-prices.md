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
  allocates a coupon pro rata over line subtotals (unchanged); WooCommerce goes per unit,
  highest price first (EX-08: WooCommerce 334/666, Otta 500/500), which can move a cent of
  tax between lines.

- No existing store's charges change: the domain and plugin goldens keep every money
  figure (the INR case's shipping tax stays 882). They gain `requiresShipping` on quote
  lines; rate-less stores' snapshots record `otta.tax-disabled`.
- An order taxed at the shop base address with no shipping zone (a digital-only cart) records
  `located: true` on its v1 tax snapshot, so its pages and emails show the tax charged rather
  than "Not calculated". v1 snapshots written without the field read as not located (the
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
- Follow-ups, not built: shop-page price display; hiding the tax row when tax is off; per-line prices with/without tax on the
  review table and the cart page; postcode/city matching, priority/compound rates, CSV;
  customer tax-exempt; adjusting inclusive prices for non-base buyers; finer rate
  precision; buyer-location tax for digital goods; WooCommerce-style coupon allocation (per
  unit, highest price first — EX-08); itemized tax rows on the order pages, the emails and
  the admin order detail; marking a tax-inclusive order on the admin order detail (its
  subtotal is the gross, and nothing there says the tax is included); recording each line's
  tax status in the frozen order tax record (PR 2b left the record's shape unchanged).

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
