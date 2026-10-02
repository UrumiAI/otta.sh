---
"@otta-sh/plugin": minor
"@otta-sh/admin-presentation": minor
"@otta-sh/admin-react": minor
---

Cancelling a paid order in the Orders console refunds the buyer and restocks the items
(QA T1-4). Before this, cancelling a paid order kept the money captured, left the stock
unchanged, and the dialog said the cancel "releases the held stock".

- **`@otta-sh/plugin`.** `InProcessAdminOrdersClient.cancelOrder` runs the domain's
  `cancelOrderWithRefund` with the order's own gateway and the inventory store, and takes
  `restock` (default `true`). The ok result carries `refund` and `restockedUnits`. A failed
  refund cancels nothing and answers `REFUND_FAILED` with the refund leg's `refundFailure`;
  `REFUND_NOT_AUTOMATIC`, `REFUND_IN_FLIGHT` and `CANCEL_LOST_AFTER_REFUND` are `409`s. The
  console's cancel write reads `restock` from its payload (absent means ticked) and gives
  every outcome its own notice: "Order cancelled and refunded" with the amount and the restock,
  or a refusal that says nothing was changed.
- **`@otta-sh/admin-presentation`.** `CancelEffects` describes what a cancel does with money
  and stock; `cancelBannerText`, `cancelGroupLabel` and `cancelConfirmText(reason, effects)`
  compose the copy from it. A pending order's copy is unchanged. `CANCEL_RESTOCK_LABEL` and
  `CANCEL_RESTOCK_HINT` label the new checkbox.
- **`@otta-sh/admin-react`.** A paid order's cancel group states the refund by amount, offers
  **Return the items to stock** (ticked) when the order has physical lines, and sends the
  choice with every cancel. When Otta cannot issue the refund, the group offers no cancel
  control and says what to do instead.
