# 0031. The store's tax options follow WooCommerce core, and an existing store keeps today's tax

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
   offered (decision 5): Otta holds none.
2. **Defaults and the upgrade rule.** A new store gets WooCommerce's defaults: tax off,
   prices without tax, shipping address, based on cart items, per-line rounding, excl,
   itemized. With nothing saved, `effectiveTaxSettings` decides: any rate exists ⇒
   `LEGACY_TAX_SETTINGS` (on, `legacy` shipping class, one "Tax" row: exactly today);
   none ⇒ the new-store defaults. The first rate created, or the last deleted, on a store
   with nothing saved first writes its current options down, so adding or removing rates
   can never flip a store between the two. Tax off asks no calculator, outside ones
   included, as WooCommerce's integrations need "Enable taxes".
3. **Prices entered with tax** (ADR-level maths, all integer, half up): a line's tax is
   the tax inside its discounted gross, `round(G × r / (10000 + r))`, and the total adds
   only the shipping tax. `totals.tax` stays the whole tax; the snapshot's
   `pricesIncludeTax` tells readers. Shipping is always entered without tax. Buyers outside
   the base location pay the same gross (WooCommerce's adjustment is a follow-up).
4. **Rounding at subtotal**: one rounding per class over the class's summed amount, then
   allocated back to its lines by amount (largest remainder), so the snapshot keeps per-line
   amounts that add up.
5. **Tax location**: `base` taxes at the shop's base address (falling back to the ship-to
   when none is set). A cart with only digital goods is taxed at the base address when one
   is set, and stays untaxed, exactly as before, when none is. A location no zone matches
   gets no rate, so 0%, never a refusal.
6. **Display**: the quote reply carries the tax per label and the display options; the
   checkout shows prices with or without tax and the tax itemized or as one row, every row
   still summing to the total. Labels are merchant or calculator text and are rendered only
   as escaped text. A store with tax off, or with nothing saved, renders exactly as before.
7. **Admin**: a "Tax options" drill-in on the Tax page; a save is guarded on the value the
   form loaded (a compare like the tax rate's `expectedRateBps`), so a concurrent change is
   refused as stale rather than overwritten.

## Consequences

- No existing store's charges change: the domain and plugin goldens keep every money
  figure (the INR case's shipping tax stays 882). They gain `requiresShipping` on quote
  lines; rate-less stores' snapshots record `otta.tax-disabled`.
- With prices shown the other way from how they were entered and a coupon applied, the
  subtotal and discount split the line tax pro rata, because tax is known only on the
  discounted lines; the rows still sum exactly.
- A site that registered an outside calculator (ADR-0030) on a store with no rates must
  switch tax on.
- Follow-ups, not built: product tax status and shipping-method taxable (PR 2b); shop-page
  price display; hiding the tax row when tax is off; per-line prices with/without tax on the
  review table and the cart page; postcode/city matching, priority/compound rates, CSV;
  customer tax-exempt; adjusting inclusive prices for non-base buyers; finer rate
  precision; buyer-location tax for digital goods.
