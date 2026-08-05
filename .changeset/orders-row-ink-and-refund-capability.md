---
"@otta-sh/admin-react": patch
---

Orders list and detail: give the rows two anchors, right-align the money, make
the drill-in read as a link, and badge only the status that needs attention.

The list's cells all carried identical weight and colour, so nothing in a
forty-row scan said who or how much. Customer and total now carry weight 600 at
full strength while the placed date and the short id recede to 0.72 opacity;
every cell stays 13px, because a dense operational grid wants a stable line
height, not a type ramp. The total column and its header end-align so the
tabular figures line up, and the same treatment reaches the detail's quantity,
unit price and line total, the totals ladder and the refund ledger.

The drill-in prefix was a real link rendered as static text. It keeps its
inherited colour — a fixed foreground cannot be safe in both themes — and gains
weight, a muted underline at a 2px offset, and padding paid back by an equal
negative margin so the target is larger than the four glyphs without the row
growing. The copy control beside it now fades until its row is hovered or holds
focus, through opacity rather than visibility, so it never leaves the tab order.

`failed` is the only order status drawn as anything other than the word itself,
on the list and on the detail alike. A mark on every row marks nothing.

Also fixed: the refunds panel warned that refunding here issues a real refund
through the payment provider even on an order that was never captured — one line
under a heading saying there is nothing to refund. The line is now withdrawn by
the same predicate that decides whether a refund can be made at all, rather than
by a second condition of its own.
