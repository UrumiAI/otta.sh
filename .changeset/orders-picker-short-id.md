---
"@otta-sh/plugin": patch
---

Admin Orders: name the order in the drill-in picker and in the refund confirm.

The picker label deliberately omitted the id, so two orders of one repeat customer
with the same total in the same state rendered **character-for-character identical**
options — and the refund confirm named the amount and the buyer, precisely the two
attributes both candidates share. Between them an operator could stage a refund
against the wrong order with nothing on screen to catch it.

New `admin/scaffold/short-id.ts` implements the console-wide UUID display rule:
`shortIdsFor(ids, min = 4)` returns the shortest prefix unique among a candidate
set, extending one character at a time only for the ids that actually collide, and
`shortIdFixed(id, len = 8)` takes a fixed prefix where no candidate set is in hand.
The two line up on purpose — the operator reads `#7e4c` in the picker and
`#7e4ce728` in the confirm, and can see the second starts with the first.

The picker label becomes `#7e4c · alice@example.com · $15.00 · paid`, computed over
**the same `orders` array the table renders**, so "unique among the candidate set"
and "unique among the rows on screen" are the same claim (pinned by a test rather
than assumed). Block Kit options are `{value, label}` and nothing else, so the
accepted degradation is the prefix alone with no copy button; the full id stays one
drill away in the detail header. The refund confirm becomes
`Order #7e4ce728 — refund $10.00 to alice@example.com? …`, with the order named
first and kept on the recipient-dropping fallback that holds the 200-character
budget. No wire, port or money-handling change.
