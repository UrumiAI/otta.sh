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

Carrying the token in a public address is safe because of what the route does
with it, not because of what it looks like: the token is unsigned base64url
JSON, so it can be read and written by anyone, and the service re-validates the
filter it carries through the same schema a query string is held to and
re-clamps its page limit, both failing closed. A hand-written token can
therefore only restate a query the operator was already permitted to make. The
console itself never parses or mints one — the encoding belongs to the service —
and it writes the value through the query encoder, so a future token whose
alphabet is less forgiving than today's base64url still survives the round trip.

An address naming a page that will not open degrades to the first page of those
filters, with a notice that says so and deliberately does not say why: every
failure reaches this tier in one shape, so a rejected token, an expired session,
a failing service and a dropped connection are indistinguishable here, and copy
naming one of them would send an operator to fix the wrong thing. The fallback
runs at most once per visit, and the address is only rewritten once a request
actually succeeds — a recoverable failure leaves the page in the address, so a
reload after signing back in still restores it.

What a reload restores is that page, not the accumulated stack of pages a scan
walked through; the same applies to a traversal, where Back onto an earlier
page's entry re-fetches that page rather than the accumulation the operator had
built when they left it. The address carries one cursor, and replaying a scan is
a separate question that belongs with refresh semantics.
