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
  rate reads at all — never the level's `limit: 200`. The fan-out is per
  RENDER of the level, so a drill-in, a filter apply and every post-write
  re-list each pay for it; that is affordable at this bound on a registry an
  operator configures once, and it is why the bound is 25 and not `limit`.
  (Recorded follow-up, deliberately not built here: these reads carry no
  `AbortSignal` and no deadline, so a service that hangs rather than fails
  holds the render open. Cancellation belongs with a timeout policy for every
  admin read, not with a label change.)
- **Each lookup is secondary and independently contained.** A failure degrades
  that row to `Price unavailable` and never fails the level; the method list is
  the primary read, and losing the rates surface must not blank a screen whose
  other affordances still work.
- **Four price outcomes, none collapsed into another**: an amount, `No rate
  set`, `Price unavailable` (the read did not answer) and `Price not loaded`
  (no read was made — the table branch, or a rejected currency). The last
  exists so that a future change, such as service-side paging on this registry,
  cannot print `Price unavailable` and blame the service for a read nobody
  made.
- **A missing rate reads `No rate set`, never `Free` and never a zero amount.**
  A `free_shipping` method with no rate row costs a buyer nothing to see here,
  but it is also not configured, and the two must not look alike.

A rate is keyed by `(methodId, currency)`, so a price cannot be read without
naming a currency: the methods level carries the same currency filter its rates
level already had, defaulting to `USD`. Amounts go through `formatMoney`, and
the currency is named **once**, in the level's context line —
`Prices in USD — "No rate set" means no USD rate.` — which is also where the
row copy's scope is stated. That scope is load-bearing, not decoration: a store
pricing solely in EUR, read under the USD default, would otherwise be told
every method is unconfigured while its configuration is complete. Scoping the
row itself (`No rate set for this currency`) reads better in isolation and was
tried first — it makes a realistic label 63 characters against X-11's 60-char
accordion budget, so the qualifier moved to the line that already carries the
currency.

**A currency that is not a currency code is rejected before any read.** The
filter value is trimmed, upper-cased and shape-checked (`/^[A-Z]{3}$/`); a typo
returns an error banner inside a 200, with the list still rendered and the
field still editable, instead of spending up to 25 requests that will all fail
and then painting the whole list `Price unavailable` — blaming the service for
a fat-finger. The check is deliberately NOT applied to the rates level one
level down, where a single read's failure is already visible and correctly
attributed, and substituting a default would turn a typo into a wrong answer.

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

Both sandbox suites gained cases for the new label shapes, every non-amount
price outcome, the per-method read count asserted **at the cap** (25 rows ⇒
exactly 25 reads) and at zero past it, the false-absence case (a method priced
only in EUR, read under USD, then re-read under EUR), the rejected-currency
path costing zero reads, the absence of raw enums in copy paired with a
positive assertion that the select still submits them, and the class group's
block order.
