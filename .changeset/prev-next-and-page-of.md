---
"@otta-sh/admin-presentation": patch
"@otta-sh/admin-react": patch
---

Previous, Next and `Page N of M` on the two React lists.

The Orders and Pricing & inventory lists now carry a pager beside `Load more`.
`Next` moves forward one page and `Previous` moves back one, both exactly — the
console keeps the cursors it has already been handed and replays one to go back,
so there is no new query, no reverse keyset read, and nothing new on the wire.

`Previous` re-requests the page rather than restoring the rows it had in hand.
The stack holds cursors, not pages: a request under a token the service already
issued answers with the collection as it stands now, agrees with a reload of the
same address, and does not grow without bound down a long scan.

**The two ways forward are two acts, not two spellings of one.**
`Previous`/`Next` move a one-page window; `Load more` extends it and keeps the
rows above. Both advance the same position, so the page number counts either.
Paging on from an accumulated scan therefore continues from where the scan
reached and shows that page alone — which `Next` says in front of the click
rather than leaving to be discovered after it. While several pages are on
screen the position states the window it describes (`Pages 2–3 of 6`), because
"Page 3" over fifty rows beginning at page two tells whoever is reading the top
of that list the wrong number.

**The page count is derived from what the list already holds.** The service
counts the filtered set alongside the page it returns and the plugin states the
page size it pages by, so the count is arithmetic over two values already on
screen — never a second request. It consumes the figure the count line actually
stated rather than the raw payload number, so a total the caption withheld
cannot reappear underneath it; the two lines can still drift if the store
changes between the count and the page, but only for that reason. A service that
reports no total leaves an em dash rather than a guess — absent is not one, and
it is not zero. A render standing on the last page states that page as the
count; where the arithmetic insists there are more pages than the one being
stood on, the two disagree outright and it states neither.

**The stack resets whenever the filter does**, in the address bar as well as in
memory: a cursor is only meaningful against the predicate it was issued under,
so a stack that survived an apply would offer to step back into the set the
operator just left.

**Paging survives the browser's own Back and Forward.** The address carries one
cursor, which is what makes a link shareable; the history entry carries the walk
behind it, which a link must not. Without that, a Back onto a page an operator
had walked to came back as though it had been pasted in — position unknown,
`Previous` unavailable, two presses into a scan. Returning to page one deliberately
pushes an entry, as any other page does; only the recovery from a page that
would not open still corrects the entry in place.

**A page nothing holds a record of cannot know its own number.** The position
reads `Page — of 6` and `Previous` is offered dimmed, carrying the reason: the
page before this one is not known here. It states that ignorance and not how the
operator arrived, which a reload, a bookmark and a link all reach identically.
Paging forward from such a page still comes back to it, and a link to the LAST
page keeps its pager rather than vanishing at the moment it is the only thing
that could say where the operator is.

Where paging has stopped — a page that failed, or a continuation the service
refused mid-scan — the whole pager is withdrawn along with `Load more`, and the
rows stay exactly where they are. A failed page never clears the rows now,
whichever direction it was asked for; the refusal is drawn beside them, and its
wording names no direction, because three controls produce it and only one of
them is "more".

On Pricing & inventory, a page reached with `Next` or `Previous` keeps the
banner raised when the low-stock threshold could not be read. Every request
carrying a cursor reports the filter as available by contract — the predicate
rode inside the token — so treating that as an answer would drop the banner at
the click of a control that has nothing to do with filtering, and start
captioning the whole catalogue as low stock.

The controls are dimmed with `aria-disabled` rather than disabled outright, so
they keep their place in the tab order and their visible focus ring: pressing
`Next` onto the last page would otherwise take the control out from under the
operator's focus. The reason a control is dimmed is exposed as an accessible
description rather than only as a tooltip, and the dimming is carried by the
border so the label stays legible.
