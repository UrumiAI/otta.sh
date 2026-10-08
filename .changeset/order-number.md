---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
"@otta-sh/admin-react": minor
"@otta-sh/admin-presentation": patch
---

Orders now have a shopper-facing **order number** — `"#"` + the first five characters of
the order id, upper-cased (`#3F9A2`) — from one new domain function, `orderNumber(orderId)`
(re-exported by `@otta-sh/plugin`). It is printed on the order confirmation page, the
account order list and detail, every order email (subject — `Order confirmed #3F9A2 —
Otta Tee` — and body), and the admin console's list and detail. The admin order wire
gains `orderNumber` on list rows and the detail.

It is a display label derived on read, never stored and never a lookup key (ADR-0033):
order ids are random v4 UUIDs, so the prefix is spread out, but five hex characters will
collide eventually. The admin search accepts a number as typed (`#3F9A2`, any case) and
answers every order whose id starts with it; a search by number that answers several orders
says so, and two console rows sharing a number extend it, upper-cased, to their
shortest-unique prefix (`#FEE1D1`). The list's "Order #" column is now "Order". The refund confirm's 8-character prefix is upper-cased so
it visibly extends the number. No order id, storage format or migration changes.
