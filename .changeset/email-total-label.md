---
"@otta-sh/domain": patch
---

Order emails label the order's total with `orderTotalLabel`, the rule the order pages
use: "Paid" for every state an order reaches only after its payment was captured —
processing, shipped, delivered, completed and refunded as well as paid — and "Total"
otherwise. Emails used to say "Paid" only in state `paid`, so a shipped order's email
called captured money a "Total" while its page said "Paid". Emails that lead with a
"Refunded: X" figure still label the total "Order total", so it cannot be read as the
money coming back.
