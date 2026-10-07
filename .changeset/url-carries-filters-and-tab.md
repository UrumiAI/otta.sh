---
"@otta-sh/admin-react": patch
---

Put the list's filter and the detail's tab in the address bar.

The Orders and Pricing & inventory lists now carry their filter in the query
string (`status`, `period`, `from`, `to`, `q` on orders; `status`, `kind`,
`low`, `q` on products), and a detail link carries the tab it was shared from
(`tab=`, named by slug rather than by index). A pasted link reproduces the
screen it describes, and Back out of a record returns to the list still
filtered.

A parameter is written only when the filter is off its default, so a missing
parameter means the default rather than an error or an empty result, and an
unrecognised value falls back to the default instead of breaking the screen.
Filters and tabs replace the history entry rather than pushing one, so Back
still leaves the screen in a single press; only navigation between the list and
a record pushes.

Browser Back out of a product with unsaved edits now raises the same
confirmation the in-screen Back does, instead of discarding the work silently.
