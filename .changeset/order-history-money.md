---
"@otta-sh/domain": minor
"@otta-sh/plugin": patch
"@otta-sh/admin-presentation": minor
"@otta-sh/admin-react": patch
---

The order History tells the money story, and the Orders console is quicker to drive (QA
round 2, admin).

- **Refunds and restocks in History.** `getOrderTimeline` adds a `refund` entry for every
  refund on the ledger that moved, or is moving, money (amount, currency, status,
  purpose, who, reason; a voided attempt is not one), and a `cancellation` entry now
  carries what it refunded and whether it returned the units to stock. The console
  renders them in words ("Refund", "Refund (cancellation) — in progress", "Customer
  requested it · refunded $20.00 · items returned to stock").
- **Who.** A status move's Who is the operator who made it (the audit event's actor);
  a refund's is who issued it.
- **Human cancel reasons.** History shows the reason as the operator chose it
  ("Customer requested it"), never `customer_request`.
- **The detail names the coupon** on its Discount row ("Discount · qa2admin2"), and a
  recorded fulfilment shows its tracking URL (a link only for http(s)).
- **Enter in the orders search box searches**, as Apply filters does.
- **Refund form.** "Refunded by" is optional (the server records the signed-in operator);
  an amount with more than two decimal places says so (`REFUND_AMOUNT_PRECISION`,
  `hasExcessDecimals`) instead of "enter a valid amount greater than zero".
