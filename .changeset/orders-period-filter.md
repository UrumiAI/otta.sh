---
"@otta-sh/plugin": patch
---

Admin Orders: one `Period` select, and the console's single date-bounds
semantics.

The filter panel spent two of its four permitted fields on a pair of
always-visible date inputs answering the question an operator asks nine times in
ten — "this week". They are now one `Period` select: `Any time · Last 7 days ·
Last 30 days · Last 90 days · Custom…`. The panel goes from four authored fields
to three, and `Custom…` — nothing else — swaps the select for the two date
fields, which puts the custom shape at four. Height on this panel is recovered by
cutting fields; splitting the filter across a `columns` grid would split one
submit into several that lose each other's unsubmitted edits, so it is not an
option here. Leaving the custom shape is emptying both dates and applying, or
`Clear filters`.

**Bounds convergence.** The two labels read `From (inclusive)` and
`To (exclusive)`, which put interval notation in front of an operator and
described a `To` day that was not actually included: a bare day was padded to
midnight, so "to 12 Jul" answered with everything placed before 12 Jul began and
the day the operator named was the one day missing. Orders now uses the same
whole-day, both-ends-INCLUSIVE convention the Reports screen does — a `To` day is
sent as its end-of-day instant — and the labels are plain `From` and `To`. This
is the console's one date-bounds semantics from here on; the Reports screen
already reads this way, as does the coupon window's end-of-day handling.

One residue, and it is the port's rather than this screen's: `OrderStore`'s list
window is half-open `[from, to)` by deliberate design (MOD-7), unlike
`ReportingStore`'s inclusive `BETWEEN`, so an end-of-day upper bound covers the
whole `To` day except its final millisecond. The end-of-day instant is what the
console standardised on; the alternative — next-day midnight — would put a date
the operator never chose on the wire.

A relative period resolves against UTC now at render time, in one place, and the
active-filter summary names the preset (`period: Last 7 days`) rather than the
dates it resolved to: a summary quoting absolute dates would be a second,
independent computation of the same period, and the two can differ across a
midnight. The filter round-trips through the paging carrier as the preset itself,
never as frozen instants, so page two of "last 7 days" cannot answer a question
page one never asked. Back-button behaviour is unchanged scaffold parity (a
`back` re-lists with the level's default filter) and is now pinned by the suite
rather than left to be discovered.

No wire, port, money or service change.
