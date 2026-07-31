---
"@otta-sh/plugin": patch
---

Coupon detail: safe by default — the edit group ships closed, the window
becomes date elements read to the end of the day, the four rarely-touched
bounds collapse behind one disclosure, and a field that never reaches a submit
keeps its current value.

**The P0-class check passed, and is now pinned.** `PM §E3` flagged an
`initial_value`-vs-`placeholder` hazard on this leaf: a form field that renders
a coupon's CURRENT value as a grey `placeholder` submits it back as `""`, and
on a wire with no partial update (`PUT /admin/coupons/:id` coerces every
omitted key to null) that is a silent unset of a value the operator could see
on screen when they pressed Save. Probed against a coupon with cap, minimum
spend, both window bounds and both use bounds all set: every one already rode
as a real `initial_value`, and an untouched save round-tripped all of them
unchanged. The only two placeholders were format examples on the date fields,
shown only when those fields were empty. **No data loss existed on `main`** —
but nothing had been holding the property, so two sandbox cases now do, and
one of them submits exactly what the renderer's own `getInitialValues` would.

**The editor no longer greets a reader.** `Edit` was `default_open: true` on
every render, so a screen operators open to answer "is this code still live?"
presented a loaded full-replace editor — one stray Enter from rewriting the
coupon's expiry, cap and use bounds (`PM §E3b`). It now renders
`default_open: false`. That is a render-time call, not a programmatic close:
there is no open/close signal to read, and forcing a mounted group shut would
mean changing its `block_id`, which remounts it and discards whatever the
operator had typed. The reading costs nothing to reach — the group's D-6 label
already carries the discount and the window.

**The lifecycle is stated, and marked only when it is an exception.** The
identity strip leads with a computed `Status` in the same vocabulary as the
list column, from the same `couponStatus` — one definition, so a coupon cannot
read `expired` on the leaf and `active` in the list. It takes the slot the old
`Code` row held rather than growing the strip past D-1a's six: `Code`
duplicated the header two blocks above it, which is M-10's own reasoning — the
code IS this screen's human handle, which is why it is the header. `scheduled` /
`expired` /
`used up` each additionally raise one `alert` banner naming what checkout does
with the code; `active` raises none. The list could not badge its exceptions
because Block Kit's `format` is a property of the COLUMN, but a leaf holds
exactly one coupon, so the split is expressible there — a `banner` is the only
primitive on the leaf that outranks a field label.

**`Starts at` / `Expires at` are `date_input` elements.** Nobody hand-types
`2026-08-01T00:00:00Z` any more, and nobody mistypes it into a silent parse
failure. A date element speaks DAYS, so each edge of the chosen day is resolved
explicitly: a start OPENS its day at `00:00:00.000Z` and an expiry CLOSES its
day at `23:59:59.999Z`. The end-of-day reading is load-bearing rather than
cosmetic — the domain's window is `[startsAt, expiresAt)` with an EXCLUSIVE
end, so an expiry pinned to midnight would retire the code at the START of the
day the operator picked: a full day early, and a day earlier than this screen's
own `Valid` reading claims. Same-day windows are now expressible. Re-submitting
the day a bound already falls on is NOT treated as an edit: the stored instant
survives byte for byte, sub-day time included, so an untouched save cannot move
a bound the screen only ever displayed to day precision. A submitted day that
does not exist is REFUSED rather than rolled forward — `2027-02-30` parses
happily and would otherwise be stored verbatim, then sort after every real day
in February — and a date field arriving as a non-string is refused with a
banner naming it, never read as a silent "unchanged".

**Known, deliberate: legacy midnight expiries stay sticky.** A coupon written
before this change holds a midnight expiry, which under the exclusive end bound
still retires the code at the START of its stated day. Re-saving that coupon
untouched will NOT quietly repair it — the preservation rule above sees the same
day and keeps the same instant — so correcting a legacy bound takes a deliberate
two-save dance: move the date off the day, save, move it back, save. Preserve
over repair is the choice: an untouched save silently rewriting a stored instant
is the exact class of surprise this leaf exists to remove, and a "repair" that
fires precisely when the operator did nothing is indistinguishable from data
loss on the day the heuristic is wrong.

**The four bounds collapse without splitting the form.** Seven stacked
full-bleed inputs, five of them empty on a typical coupon, was the console's
worst proportion offender (`DESIGNER §3`). `Discount cap`, `Minimum spend`,
`Max uses` and `Max uses per customer` now sit behind one closed disclosure,
leaving four inputs drawn at rest. It is a `toggle` + `condition` inside the
SAME form rather than a second collapsed `accordion`, because an accordion
holds blocks and a form's fields are not blocks: a second group would mean a
second FORM, and F-5a forbids that here for precisely the reason this change
exists — saving the "Discount" half would null the window and the use bounds.
Nothing is hidden that the leaf does not already show as read-only text: the
cap rides in `Discount`, the floor in `Minimum spend`, and both use bounds in
the Redemptions panel.

**Blanking one of them requires having opened the disclosure.** A blank
arriving from a bound the operator never revealed cannot be an instruction —
they could not see the field, let alone empty it — so it reads as "unchanged"
too. Today that changes nothing, because the pinned renderer posts each hidden
field's own `initial_value`; it closes the one remaining way property (3) below
could be defeated, by a renderer that CLEARED hidden fields rather than dropping
them, which the absent-key fallback alone would not catch.

**A field that never reaches the submit keeps its current value.** Today a
`condition`-hidden field's value does arrive — `blocks/form.tsx` seeds its
state from every field's `initial_value` and posts that state whole, while its
render pass returns `null` for the hidden ones. That is an interaction between
two upstream implementation details, and `carrier.ts` already REFUSES to depend
on it as a hidden-context channel because a future release could legitimately
change it. Depending on it for data PRESERVATION would leave every collapsed
bound one upstream refactor away from the exact loss this change retires, so
the form also carries each current value in its `block_id`: an ABSENT key means
"unchanged", while a PRESENT BLANK one stays the explicit unset the group's
warning promises. Money crosses that carrier as its integer minor-unit string,
never a decimal.

Everything that comes back out of that carrier is treated as untrusted input,
because a carrier round-trips through the operator's browser as a DOM
attribute. Amounts and counts must be plain non-negative integers; the two
window instants must survive `parse → toISOString` unchanged, which is a
stricter test than "it parsed" for the same reason as above. Anything else
reads as "no current value" rather than reaching the record. `curCap` is
carried only for the type that renders a cap field: a `fixed_amount` coupon
holding a stray `capCents` (reachable — the service validates each column, not
the pair) would otherwise have had every save refused, naming a percentage-only
field that is not on its screen, with no way out from the console.

**The destructive-semantics warning outranks the labels it warns about.** It
was a `context` line — the same weight as the field labels below it, quieter
than their values — for the one sentence that says a blank field destroys a set
value. It is now an `alert` banner inside the group (nested, so it does not
count against the top-level banner budget).
