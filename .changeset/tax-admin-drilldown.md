---
"@otta-sh/plugin": minor
---

Tax admin drill-down UI (admin-UX Increment 3, slice 2): a new `/tax` admin
screen — tax classes (registry list/create) drilling into a class's tax
rates (list/create/edit-with-CAS/delete). Built entirely on the existing
list/detail scaffold and `AdminRulesClient` (both landed in prior slices) —
no domain or service change.

This is the FIRST production screen where both scaffold levels are LISTS (no
leaf level): a class drills straight into its rates list, not a detail. Row
mutations (create/edit/delete) are `customAction`s that re-render the
relevant list with a notice banner — the scaffold's list-level notice, a
small, backward-compatible extension of `list-detail.ts` this slice adds
(`ListLevelDef.render` gains an optional `notice`; `CustomActionApi.showList`
gains an optional `notice` param, mirroring `showLeaf`'s existing one).

Rate percent is a TEXT input parsed to integer basis points by exact integer
string math (never a float): "7.25" → 725 bps, "0" → 0, "100" → 10000,
matching the domain's own `rateBps` precision (hundredths of a percent).
Deleting a rate carries danger copy noting in-flight carts recompute while
existing orders' snapshotted totals are untouched.

**Scope note**: renaming or deleting a tax CLASS is intentionally NOT
offered. `deleteTaxClass`'s in-use guard exists in `@otta-sh/domain`
(contract-tested) but was never wired to a service HTTP route, and there is
no domain port method for renaming a class at all — both are real
domain/service work for a future slice, not something a UI-only slice should
add. Tax RATES are fully wired end-to-end already, so this screen ships their
complete create/list/update-with-CAS/delete-idempotent surface.
