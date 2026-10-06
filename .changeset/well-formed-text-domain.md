---
"@otta-sh/domain": minor
---

Text a document store can hold (security review R3-B, X1). `isWellFormedText`,
`toWellFormedText`, `findIllFormedText` and `repairIllFormedText` name the one rule
Postgres's `jsonb` imposes on every stored string: no lone UTF-16 surrogate and no
U+0000. `JSON.parse` keeps both, `JSON.stringify` writes them as `\ud800` / `\u0000`
escapes, and `jsonb` refuses either — for every row a query casts, so one such string
used to make a whole collection unqueryable. Every other character (controls,
noncharacters, emoji and other surrogate pairs) is well formed and unaffected.

`findIllFormedText` returns a path safe to log: an ill-formed key, any key that is not
a plain camelCase field name, and every key of a map keyed by data (`lines`,
`mutations`, `holds`, `variants`, … or any object with a non-field-name key) is
written `(key #n)`. `repairIllFormedText` never
merges two keys that repair to the same text: it keeps the key that was already well
formed (else the first) and reports each dropped entry to an optional callback.

`normalizeOrderAddress` now refuses an address any of whose fields is not well-formed
text as `INVALID`, so `createOrderFromCart` answers `INVALID_SHIPPING_ADDRESS` for it
on every transport.

`expireOrdersBatch` treats each order as its own unit: a throw from one order's
expiry flip or release is logged and the batch moves on, so one order the store
cannot handle neither ends the tick early nor leaves the orders after it holding
their stock.

`expireOrdersBatch` also takes a `backoff` (the new `UnitBackoff`): an order whose
flip threw waits before it is tried again (5 minutes, doubling to an hour), and the
call lists that many more candidates and leaves the waiting ones out, so a few
orders that fail every time cannot take every call's bite and starve the orders
behind them. A `stopsBatch` predicate (sweep options) names an error that ends the
whole call — the cron tick's query ceiling — which is rethrown rather than logged as
one order's failure. A unit failure is logged as the error's name, code and a short
message with quoted values (an unclosed quote runs to the end) and email-shaped text
removed; the message is cut to 1 KB before it is scrubbed, so the work per log line
is bounded whatever a driver puts in its message.
