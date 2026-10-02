# 0026. Admin order actions never claim money that did not move

- Status: accepted
- Date: 2026-10-02
- Decided by: the maintainer, 2026-10-02 (QA findings T1-3, T1-4, T1-6)
- Refines: the Phase-5 order state machine, as the admin console applies it. Amends no earlier
  ADR.
- Numbering: 0025 is reserved by the coupon-codes branch (feat/coupon-codes-case-insensitive),
  which lands it separately.

## Context

QA drove the React Orders console against a store taking real Stripe test payments. It found
admin status moves that told someone money had moved when it had not:

- **T1-3 — Mark paid.** An unpaid Stripe order (Money tab: captured $0.00) was marked paid in one
  click. The buyer received "we've received your payment", and Reports counted $12 of revenue.
  The state machine allows `pending → paid`, and the console offered every legal move.
- **T1-4 — a bare cancel.** The console steers Cancel through the Cancel group, but the server
  still accepted a hand-made `→ cancelled` transition. On a paid card order it cancels with no
  refund, no restock and a "cancelled" email. On any order it records no reason, and it does not
  release the order's adopted stock holds: the bare transition records a release intent only for
  `expired`. The store's `cancelOrder` records both.
- **T1-6 — Mark refunded.** This status-only move sent the buyer "your order has been refunded",
  although it moves no money.

## Decision

A new domain use-case, `transitionOrderAsAdmin`, carries every status move made by hand. It is
`transitionOrder` (the same legality, idempotent no-op and guarded flip) plus three rules.
`adminNextStates` is the matching offer, so the console renders no button these rules would
refuse. A hand-made request is still refused in the domain.

1. **No manual mark-paid, and the rule fails closed.** `pending → paid` is refused with
   `MANUAL_PAYMENT_NOT_ALLOWED` unless the order's payment method is DECLARED offline. The
   declaration is a `Record` over `PaymentMethod` with the values `"gateway"` and `"offline"`, so
   a future bank-transfer or cash-on-delivery method must say which kind it is. Today Stripe and
   x402 are both `"gateway"`: x402's facilitator verify is the same kind of confirmation as
   Stripe's. An order with no method on file is refused too, because nothing about it could have
   been paid. So, today, no order is marked paid by hand; a gateway order becomes paid only
   through the settle path's `markPaid`.
2. **No bare `→ cancelled`, from any state.** It is refused with `USE_CANCEL`, and
   `adminNextStates` never offers it. Cancel order is the admin's one way to cancel. It records
   the reason and, through the store's release intent, frees a pending order's held stock. On this
   build Cancel order does NOT refund or restock a paid order. The refusal's copy says so and
   points the operator to Money → Refunds first, rather than implying the money is handled.
3. **Mark refunded is bookkeeping and emails nobody.** It was kept rather than removed, because it
   is the only way to close an order whose refund was made outside Otta. For a Stripe order the
   ledger cannot record that refund: its pre-flight fails closed on money the provider already
   shows refunded (ADR-0008). The move enqueues no outbox row. Its confirm and its success notice
   ("Marked refunded. No money moved and the buyer was not emailed.") both say so. Money moved through Money → Refunds emails the buyer
   from the ledger write.

`transitionOrder` itself is unchanged. It is the generic state-machine command every suite drives
orders through, and these are rules about who is acting. The admin console is the only production
caller of either.

## Consequences

- An order cannot become `paid`, be emailed as paid, or count as revenue without its gateway's
  confirmation. Supporting an offline method later is one line in the declaration, plus that
  method.
- The admin surface can no longer move an order to `paid` at all. Client-contract cases that need
  a paid order arrange one through the settlement (`arrange.settle`).
- The `refunded` state now has two meanings: money returned through the ledger (with its email),
  or a refund made outside Otta that the operator recorded (with no email). The Money tab's
  ledger shows which.
- This record leaves Cancel order's handling of a paid order's money unchanged: it neither refunds
  nor restocks. Until that changes, no copy may say that it does.
