---
"@otta-sh/admin-react": patch
"@otta-sh/plugin": patch
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

Both admin list clients now state the filter on EVERY request, the paged ones
included. They used to send the cursor alone on the grounds that the token
already carried the filter — which did not prevent the two disagreeing, it hid
it: the route took the predicate solely from the token, so a page-two request
meaning "paid orders" that carried an unfiltered token got the unfiltered set,
200, and the console captioned those rows "Paid". The route now compares the two
as predicates and fails closed, so stating both is what turns an invisible
divergence into an answerable one. Nothing folds case on the way — the
comparison is case-sensitive by design, and a client that normalised a search
term on one request but not the other would manufacture mismatches. For a
relative period the instants sent beside the cursor are the ones it was minted
with, which holds by construction: presets resolve to whole-day bounds, so two
requests on the same UTC day resolve identically.

A refused cursor is recovered where the service's own error code can be read.
`cursor filter mismatch` and `invalid cursor` both mean "drop the token and
re-issue page one with these parameters", so the client does exactly that, once,
and reports it as a flag on a successful page rather than as an error. That is
what lets the console tell a refused PAGE from an unreachable SERVICE — the two
want opposite treatments of the address bar — and it is why the Pricing &
inventory route now resolves the low-stock threshold before paging too: a paged
request that omitted it would describe fewer axes than its token and be refused
every time.

An address naming a page that will not open degrades to the first page of those
filters, with a notice that says so and deliberately does not say why: every
failure reaches this tier in one shape, so a rejected token, an expired session,
a failing service and a dropped connection are indistinguishable here, and copy
naming one of them would send an operator to fix the wrong thing. Only a genuine
cursor refusal resets, because only that one arrives as a page rather than as a
failure; everything else leaves the cursor in the address, so a reload after
signing back in still restores the page.

What a reload restores is that page, not the accumulated stack of pages a scan
walked through; the same applies to a traversal, where Back onto an earlier
page's entry re-fetches that page rather than the accumulation the operator had
built when they left it. The address carries one cursor, and replaying a scan is
a separate question that belongs with refresh semantics.
