---
"@otta-sh/plugin": patch
---

Tax and Shipping: lead every row label with the number it exists to show, stop
printing raw enums at operators, and order the tax-class controls
common-path-first. Presentation only — no port, wire format or money handling
changes, and the service is untouched. Both screens stay Block Kit.

**Tax rates lead with the rate.** `20.00% — European Union · eu-standard-vat ·
also shipping`, where the label used to open with the slug. Slugs vary in
length, so no two rows started their number at the same x and `20.00%` /
`0.00%` / `8.75%` could not be compared down the column — the one comparison a
rate list exists to support. The fallback branch's drill-in options lead with
the rate for the same reason. A percent is not money: it keeps
`formatBpsAsPercent`'s exact integer basis points and is never currency-
formatted. The slug stays in the label **in full** — a tax rate id is a
readable natural key, not an opaque uuid.

**Shipping methods lead with the price, which was previously not on the screen
at all** — not in the row, not inside the expanded row, only two levels down
under the rates drill-in. `€12.00 — Express courier · eu-express · flat rate`.
The amount is not on `ShippingMethodWire` and the service exposes no
cross-method rates read, so the methods level now fetches one rate per method,
in parallel, and the cost is bounded on purpose:

- **Only on the L-9 accordion branch**, so the fan-out can never exceed 25.
  Past 25 rows the level renders the table, which shows no price and fires no
  rate reads at all — never the level's `limit: 200`.
- **Each lookup is secondary and independently contained.** A failure degrades
  that row to `Price unavailable` and never fails the level; the method list is
  the primary read, and losing the rates surface must not blank a screen whose
  other affordances still work.
- **A missing rate reads `No rate set`, never `Free` and never a zero amount.**
  A `free_shipping` method with no rate row costs a buyer nothing to see here,
  but it is also not configured, and the two must not look alike. A read that
  did not answer is likewise never reported as a rate that does not exist.

A rate is keyed by `(methodId, currency)`, so a price cannot be read without
naming a currency: the methods level carries the same currency filter its rates
level already had, defaulting to `USD`, and names that currency **once** in the
level's context line rather than as an ISO code per row. Amounts go through
`formatMoney`.

**No operator-facing copy names a raw enum.** The methods context line reads
`"Flat rate" always charges its rate; "Free shipping" charges nothing above its
threshold.`, and the fallback table's `Type` badge reads `Flat rate` /
`Free shipping`. The wire values are untouched — `flat_rate` / `free_shipping`
still go over `ctx.http` and still come back; only the copy changed.

**A tax class's controls are ordered by what an operator does most.** `View
rates` first, then the rename form, then the delete, last and alone. Order is
the only affordance available: a `form` renders `flex flex-col` in the pinned
renderer, so nothing here can sit in a horizontal row with the primary on the
end, and which control comes first is the whole signal. The separator between
"edit this" and "destroy this" is a context line, because Block Kit has no
spacer block and `divider` is off this console's vocabulary — and it earns its
height by stating the refusal *before* the click, where the confirm dialog's own
copy only appears after.

Both sandbox suites gained cases for the new label shapes, the two non-amount
price outcomes, the per-method read count and its bound at the branch boundary,
the currency filter's re-price, the absence of raw enums in copy paired with a
positive assertion that the select still submits them, and the class group's
block order.
