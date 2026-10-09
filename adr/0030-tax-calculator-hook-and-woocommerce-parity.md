# 0030. Tax is calculated through one replaceable calculator, with no country law in core

- Status: accepted
- Date: 2026-10-07

## Context

Otta is a global commerce plugin. Phase 6 gave it a merchant-configured tax engine:
tax classes, one rate per (class × shipping zone) in integer basis points, an
"applies to shipping" flag, and per-line half-up rounding, computed in `computeQuote`
(the single pricing path for the checkout review and for order creation). Two gaps
remained:

1. A merchant whose tax is not a flat table (US sales tax by address, VAT for digital
   goods, an accountant's rule set) had no way to plug in a service such as Avalara or
   Stripe Tax. WooCommerce solves this with filters (`woocommerce_find_rates`,
   `woocommerce_calc_tax`) that let a plugin replace the calculation.
2. The order's tax record (`order_totals.taxBreakdown`) was untyped and carried no rate,
   no label and no record of what produced it, so nothing could read it back reliably.

A full India GST law engine, and later a large provider contract with a sandboxed
provider context, were built on side branches and dropped (about 180 h estimated, and
the wrong goal for a global product: law belongs to the merchant's configuration or to
the service they choose, not to core).

## Decision

1. **One hook, one call site.** `@otta-sh/domain` defines `TaxCalculator`
   (`calculate(request) → result | refusal`). The request is generic, in the style of
   Avalara and Stripe Tax: lines (quantity, unit price, discounted amount, tax class,
   product tax status), the shipping charge, origin and destination addresses (country,
   region, postcode, city), currency, price mode and the matched zone. The result is a
   tax line per request line and for shipping (rate, label, amount in minor units).
   `computeQuote` is the only caller: the review quote and order creation (every payment
   method) go through it.
2. **The built-in is the rate table.** `otta.rate-table` reproduces Phase 6's arithmetic
   bit for bit (pinned by a property test against a frozen copy of the old code and by
   both characterization goldens, whose only change is the snapshot shape). It never
   refuses: a class with no rate is 0%, as in WooCommerce. Its label is the tax class
   name. It reads nothing for a cart with no matched zone. A stored rate above 1000%
   (only data written outside the admin, which caps at 100%) still charges exactly as
   before; only the display rate it reports is capped at 1000%.
3. **Registration.** A site gives em-dash its own entry module containing
   `export default createOttaPlugin({ taxCalculator })` and points the descriptor's
   `entrypoint` at it. That em-dash bundles a site-local entrypoint like the package
   one was proven by a build spike, not by a committed test. em-dash imports the
   entrypoint from a generated virtual module, so a relative path does not resolve: the
   site must give an absolute path (for example
   `new URL("./otta-entry.ts", import.meta.url).pathname`) or a package alias. The
   default export, and sandboxed mode, use the built-in. Registering a calculator with
   the same id again replaces it (a dev server re-evaluating the entry module); one with
   a different id throws.
4. **The answer is checked, not the code.** An outside calculator's answer is validated
   against the request: same currency; exactly one line per request line (matched
   through a `Map`); amounts are safe non-negative integers, no more than the taxable
   amount × 1000% (the rate's own bound, so a units mix-up cannot overcharge); rates are
   integer basis points in [0, 1000%] (display only, so 8.875% may be rounded for
   display while the amounts stay exact); labels are 1–200 characters without control
   characters; no non-zero shipping line unless shipping was asked about (a zero one is
   dropped); the tax and the order total are safe integers. Only those fields are
   kept. A throw, a refusal, an invalid answer or no answer within
   **5 seconds** fails the quote with `TAX_UNAVAILABLE`, which `createOrderFromCart`
   reaches before any coupon redemption, order insert or hold adoption, so nothing
   moves. The request handed over is frozen.
5. **A calculator is trusted code, and may fetch.** It runs in-process with
   `globalThis.fetch`, outside the plugin's `ctx.http` + `allowedHosts` fence. This is
   accepted: a calculator is code the merchant chooses to install, like a WordPress
   plugin, and it is registered from the site's own source, not from data. Sandboxing it
   is the dropped provider-context work, not part of this decision.
6. **The order freezes a typed snapshot.** `taxBreakdown` becomes
   `{ v: 1, calculatorId, pricesIncludeTax, lines: [{ lineIndex, taxClassId,
   taxableCents, rateBps, label, taxCents }], shipping }`, written once at order
   creation and never recomputed. Older orders keep their untyped shape;
   `readOrderTaxSnapshot` reads them as v0 (amounts only, rate and label `null`). No
   stored document is rewritten, and `totals.tax` stays authoritative for every order.

## Why there is no country law

Tax law changes by jurisdiction, by date and by product, and a merchant is responsible
for charging it correctly. A core that encodes one country's law is wrong for every
other country and becomes a compliance product Otta would have to maintain. WooCommerce
core ships no rates either: the merchant enters them, or installs a service. Otta now
does the same. Invoices, credit notes, filing exports and tax-number validation are
likewise left to the merchant's tools.

## WooCommerce parity

This record gives Otta WooCommerce's *shape*: classes, rates per location, "applies to
shipping", 0% for a missing rate, and a replaceable calculation. Its settings (tax on or
off, prices entered with or without tax, calculate by shipping or shop address, the
shipping tax class rule, rounding at subtotal, display with or without tax, product tax
status, taxable shipping methods) come in the next change, on top of this hook.
Differences that remain and are pinned, not fixed, here: zones are shipping zones
matched by country and subdivision only; the shipping tax class is the class of the
last shipping-flagged rate. (Duplicate (class, zone) rates were pinned here too; they
are now refused — see the amendment below.)

## Consequences

- A merchant can use Avalara, Stripe Tax or their own service without forking Otta.
- An outside calculator is called once per successful quote (a refused quote never
  reaches it) and once at order placement with `purpose: "order"`. A review page can
  quote twice (with and without a preselected method), so a checkout typically costs
  2–3 calls. Answers are not reused across requests: the order call is the one a
  provider records as a transaction, and reuse would need a shared cache.
- A slow or broken calculator stops checkout with a clear message instead of charging
  the wrong tax.
- Orders now say which calculator priced them and at what rate and label. A label is
  calculator-supplied text: wherever it is later rendered (pages, emails, invoices,
  the admin) it must be escaped by the template, never inserted as raw HTML.
- Known limitation: the review page's quote sends only country and region, while the
  order sends the postcode and city too. A calculator that prices by postcode may
  therefore show one tax on the review page and charge another on the order (the pay
  page shows the order's total). Follow-up: send the postcode on the review once the
  address is known.
- `TotalsBreakdown` is unchanged, so emails, pages and reports read the same totals.

## Amendment (2026-10-08): one rate per (class, zone)

Two rates for one class in one zone used to be accepted, and then resolved differently:
checkout charged the highest id, `getRate` answered the lowest, and the admin listed
both with no sign that one was ignored. A duplicate is now defined by the model's own
key — **same tax class and same zone**. Nothing else matters, because the rate table has
no priority, compound flag, postcode or city that could tell two such rates apart.

- **Refused at the store.** `TaxRulesStore.createRate` throws `TaxRateDuplicateError`
  (code `TAX_RATE_DUPLICATE`) naming the rate already in the slot, and writes nothing.
  The admin shows: `Class "standard" already has a rate for "United States": "std-us"
  (7.25%) …`. A rate's class and zone cannot be edited, so `updateRate` can never make a
  duplicate.
- **Race-safe without transactions (ADR-0019).** Every rate of a class is embedded in
  that class's one document, so the slot check reads the same document, at the same
  revision, that the embed is compare-and-set against. Of N concurrent creates for one
  slot, one embed lands; every other compare-and-set refuses, and its retry re-reads,
  finds the winner and is refused as a duplicate. A refused create keeps its id claim
  (releasing it could race a same-id create that adopted it); the orphan misleads no
  reader and is adopted by the next create of that id, in any class. The race is proven on Postgres by `rules-cas-race.pg.test.ts` (24 creates × 12
  loops, for one slot, for many zones of one class, and for an undeclared class). The
  contract's concurrent-create case runs on every backend, but SQLite and D1 serialise
  writes, so there it proves the logic, not the race.
- **Existing duplicates are kept, never deleted.** One rule resolves them everywhere,
  in `@otta-sh/domain` (`effectiveTaxRates`, `appliedTaxRate`, `shadowedTaxRates`):
  **the greatest rate id applies; the others are ignored entirely.** On goods that is the
  rate checkout already charged, so no line-item tax changes. `getRate` answers the same
  rate.
- **Behaviour change — shipping tax, for stores that already hold duplicates.** "Ignored"
  includes the ignored rate's "applies to shipping" flag. Where the ignored duplicate was
  the one marked "applies to shipping", shipping tax changes on the next quote: it
  **disappears** if no applying rate in the zone is flagged, or it **moves to another
  class's flagged rate** (the shipping tax class was the last flagged rate, and that was
  the ignored one), which can be higher or lower. Placed orders keep their tax snapshot.
  Chosen deliberately (user decision, 2026-10-08) so the admin's "only X applies" is true
  everywhere; the admin flags every such duplicate, and deleting the one the merchant does
  not want resolves it.
- **The admin flags them.** The class's rates page shows a warning naming each pair, and
  the ignored row is labelled `duplicate — ignored` and opens with `Duplicate: only <id>
  applies …` (the applying row: `Applies to <zone>. Duplicate <id> is ignored.`; table
  rows: `duplicate: only <id> applies` / `applies; duplicate <id> ignored`). The ignored
  row keeps an editable shipping toggle labelled "only if this rate becomes the active
  one", so the survivor can be fixed before the other is deleted; a toggle left as shown
  sends no flag, which the store applies as "unchanged" inside its compare-and-set. Both rows stay editable and deletable, so the merchant deletes the one they
  don't want.
