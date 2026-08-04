---
"@otta-sh/admin-react": patch
---

Order detail: the refunds panel stops telling an uncaptured order it was fully refunded, and a refused refund reads as a refusal.

The "fully refunded" sentence was chosen by testing the remaining amount, which is zero both when every captured cent has been refunded and when nothing was ever captured. On an order with no capture the panel therefore claimed a full refund one line under a heading saying nothing was captured. The heading and the sentence beneath it now come from a single derivation keyed on the refund ceiling, so the two can no longer be computed apart and cannot disagree. An order with a real, fully refunded capture still says so; an order with nothing captured states that once, in the heading.

The refund form's three refusals now carry the field they are about. The message takes a fail-accent inline-start rule and a heavier weight (a border and a weight, never text colour, so it holds in both themes), the offending input takes the fail border and `aria-invalid` wired to the message by `aria-describedby`, and focus moves to that input — the amount for the two amount refusals, "refunded by" for the third. Wording, refund arithmetic and the confirm flow are unchanged.
