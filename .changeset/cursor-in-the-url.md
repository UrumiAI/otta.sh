---
"@otta-sh/admin-react": patch
---

Put the list's page in the address bar.

The Orders and Pricing & inventory lists now carry the page they are showing in
the query string (`cursor=`), beside the filter parameters and the drill-in.
Paging pushes a history entry, so Back and Forward walk the pages an operator
actually visited; a reload or a shared link lands on that page rather than
silently starting again at the first one; and the filter and the page travel
together, because a keyset cursor is only meaningful against the predicate it
was issued under. Applying a filter takes the page back out of the address,
which is the same reset the list already performs in memory.

The token is the service's own opaque cursor, moved verbatim — nothing is
parsed, validated or synthesised in the browser, and it is written through the
query encoder so a token containing `+`, `/` or `=` survives the round trip.

An address naming a page the service will not open — a link older than the
filters it names, or one edited on the way — degrades to the first page of those
filters with a notice saying why, instead of a dead error pane whose Retry would
re-send the refused token. The fallback runs at most once per visit.

What a reload restores is that page, not the accumulated stack of pages a scan
walked through: the address carries one cursor, and replaying a scan is a
separate question that belongs with refresh semantics.
