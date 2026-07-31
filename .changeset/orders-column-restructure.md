---
"@otta-sh/plugin": patch
---

Admin Orders: stop leading the list with 36 characters of entropy.

The highest-traffic screen in the console opened with a full uuid in its first
column — the widest, heaviest thing on the page, and the one column an operator
never scans. Directly beneath it the drill-in picker rendered the same records as
`#7e4c · …`, so the two halves of one screen identified the same order by two
different strings.

The list is now `Placed · Customer · Status · Order # · Total`. The identity
column keeps its monospace `code` chip but renders the git-style shortest-unique
prefix, computed over the same `orders` array the picker below is built from — so
the token in a row and the token in that row's option are the same string by
construction, and the walk from table to picker is an exact match rather than a
positional guess. The prefix extends only for ids that actually collide. Money
stays in the final column: Block Kit tables have no column alignment of any kind,
so the trailing edge is the only thing that makes a money column read as one.

The order detail's H1 was `Order <uuid>` — the largest type on the page spent on
the least useful value. It becomes `Order · <customer> · <date>`, and the full id
moves down into the identity strip, where it renders verbatim. That move is what
keeps the console honest: every other surface now shows a prefix, so exactly one
place has to still carry the whole id or it stops being obtainable anywhere. The
strip took the id into the slot the customer vacated, staying at six entries so
its row-major pairing survives.

No wire, port or money-handling change; every money cell still goes through
`formatMoney` with its own order's currency, and no currency is stated in a
header the page cannot make that claim for.

Absolute list/detail timestamps are deliberately not in this change — the
`Placed` column keeps its relative rendering until the shared timestamp formatter
lands with the detail-screen timestamp work.
