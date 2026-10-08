---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
"@otta-sh/admin-react": minor
"@otta-sh/admin-presentation": minor
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
answers every order whose id starts with it, with a hint that numbers can be shared; two
console rows sharing a number extend it, upper-cased, to their
shortest-unique prefix (`#FEE1D1`). The list's "Order #" column is now "Order". No order id, storage format or migration changes.

`@otta-sh/domain` exports `orderNumber`, `ORDER_NUMBER_LENGTH` and `orderNumberIdPrefix`
(the one matcher: `#` + five or more hex digits). A search typed as a number rewrites only
the store's id-prefix arm — the `#` comes off, and a number long enough to cross a UUID
hyphen gets the hyphen back, so the stored id and its search key are unchanged; the buyer
and sku arms still match the text as typed. The admin list payload gains
`searchedByNumber`, and the console then shows "Order numbers can be shared. Confirm the
buyer, date and total."

`@otta-sh/admin-presentation` gains `withOrderNumberCells`, `orderConfirmLabel`,
`ORDER_CONFIRM_DIGITS` and the `OrderNumberCell` type: rows sharing a number extend it,
upper-cased and hex only, to their shortest-unique prefix; the refund confirm names the
first 12 hex digits. It drops `shortIdFixed` and `SHORT_ID_CONFIRM_LEN` (and the plugin's
scaffold re-exports of them), which nothing uses any more. `orderNumber` is required on the
React console's order types.
