---
"@otta-sh/admin-presentation": patch
"@otta-sh/admin-react": patch
---

Previous, Next and `Page N of M` on the two React lists.

The Orders and Pricing & inventory lists now carry a pager beside `Load more`.
`Next` moves forward one page and `Previous` moves back one, both exactly — the
console keeps the cursors it has already been handed and replays one to go back,
so there is no new query, no reverse keyset read, and nothing new on the wire.
Both controls write the page to the address through the same path `Load more`
already used, so Back and Forward keep walking the pages an operator actually
visited and a shared link still lands on the page it names.

`Previous` re-requests the page rather than restoring the rows it had in hand.
The stack holds cursors, not pages: a request under a token the service already
issued answers with the collection as it stands now, agrees with a reload of the
very same address, and does not grow without bound down a long scan.

**The two ways forward are two acts, not two spellings of one.**
`Previous`/`Next` move a one-page window; `Load more` extends it and keeps the
rows above. Both advance the same position, so the page number counts either —
what differs is whether the rows stay. Paging from an accumulated scan therefore
continues from where the scan reached, and collapses the view to that one page.

**`M` is derived from what the list already holds.** The service counts the
filtered set alongside the page it returns and the plugin states the page size
it pages by, so the page count is arithmetic over two values already on screen —
never a second request. It is refused on exactly the totals the count line
refuses, so `Page 2 of 6` and `137 orders` cannot contradict each other, and a
service that reports no total leaves the count an em dash rather than a guess:
absent is not one, and it is not zero. A render standing on the last page states
that page as the count, which is direct evidence rather than arithmetic and is
also the only answer available without a total.

**The stack resets whenever the filter does.** A cursor is only meaningful
against the predicate it was issued under, so a stack that survived an apply
would offer to step back into the set the operator just left. Applying a filter
puts the list on page one with nothing behind it, and the pager says so.

**A page opened straight from a link cannot know its own number.** An address
names which page, never how many came before it, so the position reads `Page —
of 6` and `Previous` is offered dimmed, carrying the reason: this screen has no
record of the page before this one. Paging forward from such a link still comes
back to it. Inventing "page 2" because one cursor was seeded would be a number
an operator reconciles against and loses.

Where paging has stopped — a failed page, or a continuation the service refused
mid-scan — the whole pager is withdrawn along with `Load more`. The rows already
loaded stay exactly where they are; what goes is the paging, and it goes because
the screen has just disowned its position in the address.

The controls are dimmed with `aria-disabled` rather than disabled outright, so
they keep their place in the tab order and their visible focus ring: pressing
`Next` onto the last page would otherwise take the control out from under the
operator's focus and drop it to the top of the document.
