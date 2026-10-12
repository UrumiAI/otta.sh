# 0036. Tax rates finer than a basis point: an optional `ratePpm` beside `rateBps`

- Status: accepted
- Date: 2026-10-09

## Context

Built-in tax rates were whole basis points (`rateBps`, 0.01%), so a real combined rate
such as New York City's 8.875% could not be entered (#425). WooCommerce stores a rate as a
decimal string with **four** decimal places (`WC_Tax::format_tax_rate` is
`number_format($rate, 4, '.', '')`; the column is `tax_rate varchar(8)`), so four decimals
of a percent — one hundredth of a basis point, a **millionth** — is the precision to match.

`rateBps` runs through the domain port (`TaxRate`, its create/update inputs and the
compare-and-set expectation), the rate-table calculator, the outside-calculator answer
(`TaxLine.rateBps`, ADR-0030), every order's frozen tax snapshot, the emdash tax-class
documents in `ctx.storage` and the admin console. Stored rates are documents, not SQL
rows, and migrations are forward-only.

Options considered:

1. **Change the unit everywhere** (rename `rateBps` to a millionths field, rewrite every
   stored rate and reinterpret every snapshot). Breaks the ADR-0030 contract for every
   outside calculator, needs a data migration over `ctx.storage` and a unit marker on
   every order snapshot, and touches hundreds of call sites and tests.
2. **An optional finer field beside the old one, upgraded on read** — the precedent of
   `ShippingMethodDoc.taxable` (absent reads as `true`).

## Decision

Option 2.

- A rate is `{ rateBps }` or `{ rateBps, ratePpm }`. `ratePpm` is integer millionths and
  is present **only** when the rate is not a whole basis point; it is then THE rate, and
  `rateBps` is it rounded half up (what a reader that only knows basis points displays).
  `ratePpmOf(rate)` reads either shape. Stores refuse a `rateBps` that disagrees with
  `ratePpm` on WRITE (`RangeError`) and drop a whole-bps `ratePpm`, so the pair they
  write is canonical.
- **`rateBps` is the source of truth when the two disagree.** On READ, `ratePpm` counts
  only when it is a non-negative safe integer that rounds half up to `rateBps`
  (`finerRatePpm`); anything else is ignored and the rate is `rateBps × 100`. That covers
  a document an older build edited: it knows only `rateBps`, so editing 8.875% → 9%
  leaves `{ rateBps: 900, ratePpm: 88750 }`, which reads — and charges — 9%, as the
  editor meant. Stores return rates canonically, so the stale `ratePpm` is never shown,
  and the next edit drops it. A `rateBps` that is not a non-negative safe integer makes
  `ratePpmOf` throw, so corrupt data fails closed, as `computeLineTax` always did.
- **No data migration.** A document written before has no `ratePpm` and reads as
  `rateBps × 100`. A whole-bps rate is written, stored and returned in exactly the shape
  it always had; no read rewrites a document.
- The built-in calculator computes in millionths: `round_half_up(amount × ppm / 10⁶)`,
  and `round_half_down(G × ppm / (10⁶ + ppm))` for prices entered with tax. For a whole-bps
  rate that is the same rational as `bps / 10⁴`, rounded by the same rule, so every
  existing tax amount is unchanged. Amounts stay integer minor units; `BigInt` throughout.
- `updateRate`'s compare-and-set compares the **exact** rate: a tab that only read 8.88%
  is `stale` against 8.875%.
- `TaxLine` gains an **optional** `ratePpm` (display only, like `rateBps`, which stays
  required). An outside calculator that never sends it is answered exactly as before;
  one that does must send a `rateBps` equal to it rounded half up, or the answer is
  refused. `ratePpm: null` reads as absent, but any other malformed `ratePpm` (not an
  integer in [0, 1000%]) is now refused (`TAX_UNAVAILABLE`) where before #425 it was an
  ignored unknown key. The order snapshot records `ratePpm` on a line only when it has
  one, so every snapshot written before reads back byte-identically — no version bump.
  A snapshot's `ratePpm` that is not consistent with its `rateBps` is ignored on read,
  by the same rule as a stored rate.
- The admin accepts up to four decimal places for a tax rate (coupons keep two) and shows
  at least two, with the finer digits only when there are any (`7.25`, `8.875`).

## Consequences

- 8.875% is charged exactly; existing stores, orders and outside calculators see no change.
- Two fields carry one value. The canonical rule and the store-side consistency check keep
  them from disagreeing; code that charges tax must read `ratePpmOf`, never `rateBps`.
- `RulesSnapshot.taxRatesByClass` (the pure `computeTotals` path, used by tests and pure
  callers) stays in basis points; the checkout prices through the calculator.
- **Rollback and mixed deploys.** A build from before this record reads only `rateBps`,
  so it charges a finer rate at its rounding (8.88% for 8.875%); acceptable pre-1.0, and
  why the rounded value is stored at all. Rolling forward again is safe: a rate the old
  build edited to a new value reads as that value (the stale-`ratePpm` rule above).
  One caveat: on the old build, saving 8.88 over a stored 8.875% is a no-op — its
  `rateBps` is already 888, so it writes nothing, and the rolled-forward build still
  charges 8.875%. The merchant re-saves the rate on the new build to change it.
