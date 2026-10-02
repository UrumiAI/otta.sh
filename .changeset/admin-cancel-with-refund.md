---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": minor
"@otta-sh/admin-presentation": minor
"@otta-sh/admin-react": minor
---

Cancelling a paid order refunds the buyer and restocks the items (QA T1-4; ADR-0026's
cancel-with-refund amendment; ADR-0008 amended).

- **`@otta-sh/domain`.**
  - `cancelOrderWithRefund(deps, gateway, command)` cancels a `paid` or `processing` order in
    three legs, each idempotent on a key derived from the command's:
    1. Refund what is still refundable through `refundOrder` (purpose `cancellation`, key
       `<key>:refund`).
    2. Restock each physical line exactly once. A line whose checkout hold is still `adopted`
       is committed first, so the cancel's release cannot return its units a second time; a
       lost (`released`) or unknown hold is skipped. Skipped lines are reported as
       `restockSkipped`.
    3. Cancel through the guarded flip. If the order moved but is still cancellable, the flip
       is retried once.
  - A pending order is cancelled as before.
  - A failed refund refuses the cancel and changes nothing (`REFUND_FAILED` with the refund
    leg's reason). These are refused up front: `REFUND_NOT_AUTOMATIC`, `REFUND_IN_FLIGHT`, and
    `MULTIPLE_CAPTURES`.
  - An order that ships between the refund and the flip is flagged, with the next step, and
    answers `CANCEL_LOST_AFTER_REFUND` carrying what moved.
  - `RefundPurpose` (`refund` | `cancellation` | `late-payment`) is stored on the refund row.
    Only a `refund` row can drive `→ refunded`. `settleOrder`'s automatic late-payment refunds
    are now recorded with `late-payment`.
  - `OrderCancellation` records the `refund` and whether the units were `restocked`.
  - The cancelled email states the refund and its amount.
  - Pinned in the new `cancelWithRefundContract` (in-memory fakes, both Node dialects and D1),
    in `refundOrderContract` and in `orderCancellationContract`.
- **`@otta-sh/store-emdash`.**
  - `RefundEntryDoc.purpose` is stored on the row.
  - The cancel write records `refund` and `restocked` on the envelope.
  - No migration is needed.
- **`@otta-sh/plugin`.**
  - `InProcessAdminOrdersClient.cancelOrder` runs `cancelOrderWithRefund` with the order's own
    gateway. It takes `restock` (default `true`) and reports `refund`, `restockedUnits` and
    `restockSkipped`.
  - Each outcome has its own notice. The not-automatic notice points to recording a manual
    refund in Money → Refunds.
- **`@otta-sh/admin-presentation` and `@otta-sh/admin-react`.**
  - The state-keyed cancel helpers from the mark-paid guard (`cancelBannerDescription`, the
    state-keyed `cancelGroupLabel`, and `cancelConfirmText(label, state)`) are replaced by the
    effects-based ones. `cancelConfirmText(label, effects)` now requires `effects`.
  - The Cancel group is rendered only for an order that can still be cancelled (`pending`,
    `paid` or `processing`).
  - The bare-cancel refusal's paid-order text now says Cancel order refunds and restocks.
  - A paid order's cancel group states the refund by amount and offers **Return the items to
    stock** (ticked).
  - The group offers no cancel control when Otta cannot issue the refund, or when the refund
    ledger could not be loaded. An unknown amount never reads as "nothing is refunded".
