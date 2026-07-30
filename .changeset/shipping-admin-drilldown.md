---
"@otta-sh/plugin": minor
---

Shipping admin drill-down UI (admin-UX Increment 3, slice 3): a new
`/shipping` admin screen — zones (list/create/edit-LWW/delete-forbid-if-
methods) drilling into a zone's methods (list/create/edit-LWW/delete-forbid-
if-rates) drilling into a method's currency-keyed rates (list/create/edit-
with-CAS/delete). Built entirely on the existing list/detail scaffold and
`AdminRulesClient` (both landed in prior slices) — no domain or service
change.

This is the FIRST production screen to actually reach drill depth 3 — the
scaffold's own synthetic geo fixture proved the N-level nav core worked
before any real screen needed it. Deep opens (zone → methods, method →
rates) encode the full target path into the open form's option value
(`encodePath`/`decodePath`) since a single `parseOpen` here resolves opens
fired from two different levels. The rates level exercises the scaffold's
auto filter-path-carry at depth 2 for the first time: unlike tax rates
(their own `id`, a per-zone list read), a shipping rate's identity is
`(methodId, currency)` and the service exposes only a single-currency
lookup — the level is a currency-KEYED filter (default `"USD"`, 0-or-1 rows),
not a true multi-row list.

Amounts are TEXT inputs parsed to integer minor units by exact integer
string math (never a float), same discipline as the Tax console's basis-
point parser — but UNLIKE product pricing, ZERO is a valid amount (a $0 flat
rate, or a free-shipping method's below-threshold fallback), matching the
service's own `nonnegative()` (not `positive()`) schema.

Regions are presented honestly: `ShippingZone.regions` is opaque config the
pricing engine never reads (checkout/quote takes an explicit
`shippingZoneId`, never an address-to-zone match), so the screen's copy does
not claim regions drive automatic zone selection — the field is a plain
comma-separated code list for the merchant's own reference. Both parent-
delete conflicts (a zone with methods, a method with rates) render the
actual referential-guard reason, never a raw HTTP status. Deleting a rate
carries danger copy noting in-flight carts recompute while existing orders'
snapshotted shipping fee is untouched.
