---
"@otta-sh/plugin": patch
---

Creating is a button above the data, not an accordion under it — on Coupons,
Tax and Shipping.

**The affordance moved to where the act starts.** `New coupon`,
`New tax class`, `New tax rate`, `New shipping zone` and `New shipping method`
were `accordion`s pinned to the very bottom of their level (L-8), below the
table and below the drill-in picker, rendered as a link the eye reads as one
more row affordance. Each is now a `primary` BUTTON emitted directly under the
level's intro line, above the rows. On a console whose emptiest, most common
first task is "create the first one", the create action had been the least
prominent thing on the screen.

**A button, and only a button, goes above the data.** P-1 keeps controls below
the data they act on, and a create FORM up there would break that for real:
five stacked inputs ahead of the first row. A button is one row tall and holds
no input, so the promotion costs the first screenful nothing — and the form
does not move up with it, because clicking the button drills IN. That is the
same idiom the per-row `View rates` / `View methods` buttons already use
(§12.7), now applied to the one act that had no drill-in of its own.

**The create screen is a screen.** `header` · back · notice · context · the
form — the shape every other non-list level on this console already has, so
the way out is where an operator already looks for it. The back control
re-lists the level they came from, carrying the drill path in its own `value`
(L-6): "← Back to tax rates" returns to THAT class's rates, not to the root
registry. Nothing about what a create submits changed — same fields, same
validation, same wire, same notices.

**No accordion is opened or closed programmatically to do it.** The old shape
needed B-6's two-part trick — change the group's `block_id` AND set
`default_open: true` — to reveal the create form from an empty state's button.
There is no group left to force open, so that machinery is gone, and every
level now renders with zero open groups on every list render (X-18 holds by
construction rather than by arithmetic).

**A refusal no longer costs the operator their typing, and now that is a
property of the response rather than of the client.** Every create refusal —
a blank id, an unparseable percent, a cross-type field, a duplicate id
rejected by the service — re-renders the create screen with everything that
was submitted put back as `initial_value` (DA-3a-i). Before this, the values
survived only as unsubmitted state in a form the client happened to keep
mounted, and the E-2 path did not keep it: clicking a create button from an
empty state rendered the group under a CHANGED `block_id`, so the refusal
that followed remounted it and discarded the input. The values now come back
from the server, which holds whatever the client does with the tree.

Drafts carry RAW OPERATOR TEXT, never a parsed value (DA-3a-iii property 5):
the commonest refusal on these screens IS the parse — `7.255`, `ten percent`,
`19,99` — and there are no basis points or minor units to reconstruct a
prefill from when the parse is exactly what failed. A rejected `select` value
is resolved against its own options before it is prefilled (X-23), so a draft
zone that no longer exists falls back rather than rendering a blank trigger,
and a `toggle` is restated explicitly (X-24) rather than silently reverting to
off. A create that SUCCEEDS drops the draft and returns to the list, which is
what closes the loop.

**Empty states say the same words as the button above them.** `Create a tax
class` and `Add a tax rate` and `New method` were three namings of an act the
promoted button now names once — one verb, one wording, one destination.
