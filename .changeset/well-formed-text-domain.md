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
