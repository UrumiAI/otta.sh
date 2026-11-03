# 0044. Cash on delivery is an offline payment method

- Status: accepted
- Date: 2026-11-03
- Decided by: the product owner, 2026-11-03 (a separate package, a Settings toggle, and each
  method independently enabled). This record holds the engineering decisions made within that.
- Applies: [ADR-0026](./0026-admin-order-actions-never-claim-money-that-did-not-move.md)
  Decision 1, which anticipated it. Amends no ADR.

## Context

Otta took one payment method, Stripe. A store without a Stripe account could not complete
checkout at all. Many merchants who sell physical goods are paid in cash at the door. They need
three things: checkout should place the order with no online payment; the merchant should mark it
paid when the courier hands over the cash; and nothing in Otta should claim money moved before
it did.

The domain already had the hook for this. ADR-0026 Decision 1 refuses a manual `pending → paid`
unless the order's method is declared `"offline"` in a `Record<PaymentMethod, "gateway" |
"offline">`, and it said a cash-on-delivery method "must say which kind it is".

A COD order does not fit the rest of the pending-order machinery as it stands:

- A pending order expires at its **hold deadline** (15 minutes by default). The expiry sweep
  releases its stock and frees its coupon. A COD buyer pays days later, at delivery.
- `cancelDueIntents` withdraws a pending order's payment intents at that deadline. A COD order
  has none.
- The settle path and the late-payment, anomaly and refund paths assume a gateway webhook. A COD
  order never gets one.
- The `pending` state has no email. A card order is announced by its `paid` confirmation minutes
  later; a COD order would announce nothing until delivery.

We considered three ways to hold a COD order:

1. **A new state** (`placed`, between `pending` and `paid`). This is the most expressive option. It
   is also a breaking change to `OrderState` and every exhaustive switch over it. It needs a row in
   the state machine, the email table, reports, and the admin and site copy, plus a migration
   story for the stores. That is too much surface for one method.
2. **Commit the stock at placement and leave the order `pending` with its normal deadline.** The
   order would still expire, and the expiry would then release nothing (its holds are committed),
   so the stock would be lost.
3. **Keep the order `pending` with a hold deadline that never comes.** The holds stay `adopted`.
   Mark paid commits them, as settlement does, and Cancel order releases them, as it does for any
   pending order. No store, index or migration changes.

## Decision

### 1. `cod` is a payment method, declared offline

`PaymentMethod` becomes `"stripe" | "cod"`. The settlement declaration moves to
`orders/payment-methods.ts` as `PAYMENT_METHOD_SETTLEMENT` and becomes the list of current
methods:

```ts
{ stripe: "gateway", cod: "offline" }
```

`isOfflinePaymentMethod(stored)` reads it. It fails closed: `null` and unknown methods are not
offline. `manualPaymentAllowed` is now that function, so `adminNextStates` offers **Mark paid** on
a pending COD order, and only there.

### 2. The order's life, and its stock

- **Placed.** `createOrderFromCart` places a COD order `pending` with
  `holdExpiresAt = OFFLINE_HOLD_EXPIRES_AT` (`9999-12-31T23:59:59.999Z`). Adoption copies that
  deadline onto the holds, so the order is never listed expirable, its holds never lapse, the
  coupon leg skips it as "still inside its hold", and its stock is off sale for as long as it
  stays pending. Every store already compares the deadline as an ISO string, which is why no
  adapter changes. This is option 3 above.
- **No intent.** The COD gateway's `createIntent` returns an empty `intentId`, so the order
  records no intent and the intent-cancel sweep never has one to withdraw.
- **Mark paid is a recorded payment.** For an offline order, `transitionOrderAsAdmin(→ paid)` is
  not a bare flip. A person attests that the cash arrived, and it is recorded as a gateway
  settlement would be:
  - the guarded `markPaid` flip, which enqueues the `paid` confirmation email and, in the
    document store, the commit intent;
  - then the same idempotent side-effects `settleOrder` runs (`applyPaidSideEffects`, now
    exported): a `payments` row for the order total under `offline:cod:<orderId>`, the physical
    holds committed, and the digital lines granted.

  Reports, the refund ceiling and the Money tab then read the payment like any other. A replay
  (or a crash between the flip and the side-effects) is finished by the next click, because the
  order's `paidProviderRef` names the offline payment and every side-effect is keyed. The use-case
  takes the stores it needs as `TransitionOrderDeps.offlinePayment` and **throws before writing
  anything** if they are not wired.
- **After paid**, the order moves through the existing machine: `processing → shipped →
  delivered → completed`, or straight to `completed`.
- **Cancel before payment** is the existing Cancel order. The store's release intent returns the
  adopted holds; no money moved, and no intent needs withdrawing.
- **After payment**, the cash came back by hand. The gateway is `refundable: false`, so a refund in
  Money → Refunds is a **manual** refund (ADR-0008). Recording the full amount closes the order as
  `refunded`. Cancel order on a paid COD order refuses `REFUND_NOT_AUTOMATIC`, as ADR-0026's
  amendment already does for any non-refundable gateway. The operator records the manual refund
  first. Mark refunded stays decided by the ledger; no refund-route declaration is needed.

### 3. The gateway: `@urumi.ai/otta-payments-cod`

The gateway is a separate package beside `payments-stripe`, with the same package.json, tsdown and
exports shape. `CashOnDeliveryGateway`:

| Verb | Answer |
|---|---|
| `createIntent` | `{ gateway: "cod", intentId: "", clientAction: { kind: "offline" } }`, deterministic |
| `verifyConfirmation` | always `{ ok: false, reason: "UNKNOWN_EVENT" }`, because nothing that reaches a settle route can mark a COD order paid |
| `refundable` / `refund` | `false` / `UNSUPPORTED` |
| `cancelIntent` | `UNSUPPORTED` |

`ClientAction` gains `{ kind: "offline" }`, meaning "the order is placed; there is no online
payment step". It is distinct from `none` ("nothing to pay, the order left the checkout window").

The settlement spec (`paymentGatewayContract`) cannot apply to a gateway that has no webhook. So
`payment-gateway-contract.ts` gains `offlinePaymentGatewayContract`, which the COD package runs.
It requires that no confirmation of any shape settles the order, including a well-formed signed
webhook. The lifecycle above is `offlinePaymentContract`, run against the in-memory fakes,
SQLite, Postgres and D1.

The plugin's depcruise perimeter admits `payments-cod` beside `payments-stripe`. It imports only
the domain's types and has its own sandbox-clean guard.

### 4. The buyer's email

A new `OrderNotice`, `order-placed-offline`, with template `order-placed-offline` ("Order
received … You'll pay in cash when it's delivered"), carries the amount due. Checkout enqueues it
after the intent, on both the fresh path and the replay. The store's first-wins `(orderId, kind)`
dedupe makes it one email. The dispatcher renders it like a state email: it is not a refund
notice, so it has no "Refunded" line. Mark paid then sends the ordinary `paid` confirmation ("we've
received your payment"), which is true by then.

### 5. Settings and wiring, fail closed

- Two plain kv settings: `settings:codEnabled` and `settings:codInstructions` (optional, at most
  500 characters, shown to the buyer at checkout). They have their own form in a "Cash on
  delivery" group on the Settings page. **Only a stored `true` turns COD on.** Never saved, a kv
  miss, or any other value reads as off.
- `resolvePaymentGateways` arms each method independently. Stripe is armed only when fully
  configured, as before. COD is armed only when enabled. The admin root passes
  `includeDisabledOffline`, so a COD order placed before the toggle was turned off can still have
  its manual refund recorded. The offline gateway moves no money, so arming it there grants
  nothing.
- The India Stripe-account address rule (issue #382) is about the card payment, so a COD
  checkout skips it.

### 6. Checkout chooses a method

- `storefront/payment-config` adds `cashOnDelivery: { enabled, instructions }`.
- `storefront/checkout/place` takes `paymentMethod` (`"stripe"` when absent, so every existing
  caller is unchanged). Anything else is `INVALID_INPUT`. `"cod"` while COD is off is refused
  `PAYMENT_METHOD_UNAVAILABLE` before anything is created. `"stripe"` on a store without Stripe
  is still `STRIPE_NOT_CONFIGURED`.
- The reference site offers the methods the store has. With more than one, it shows a radio
  (card first, the default) and a "Place order" button. With one, the method is carried hidden.
  A COD placement goes straight to `/orders/<id>`. There is no pay page: the site's place,
  resume and pay guards all send an offline order there. The confirmation page says "Order
  placed. You'll pay in cash when your order is delivered." It offers no "Complete payment" and
  no hold timer. The step tracker shows it at Order, and the account pages say "Placed — pay on
  delivery".
- The React Orders console names the method ("Cash on delivery", not `cod`) and offers
  **Mark paid** for a pending COD order. Its refund line says refunds are record-only for cash.

### 7. Existing stores

Nothing changes until a merchant switches COD on: the toggle reads off, the gateway is not armed
for checkout, the payment-config answer only gains a field, and a place call with no method is a
card place. No stored data is migrated or reinterpreted.

## Consequences

- A store with only COD enabled completes checkout end to end with no Stripe keys.
- An order cannot become `paid`, be emailed as paid, or count as revenue without a person's
  attestation (COD) or its gateway's confirmation (Stripe). ADR-0026's guarantee holds.
- **A COD order cannot record its shipment before it is paid.** The state machine fulfils only
  from `paid`/`processing`. A merchant ships first and marks paid on delivery, then completes the
  order. Shipping emails with tracking for an unpaid COD order would need a fulfilment step
  independent of payment, which is a follow-up (and option 1's territory).
- An abandoned COD order holds its stock until someone cancels it. Nothing expires it. This is
  deliberate: the merchant is shipping it. Reports should surface old pending COD orders, which is
  a follow-up.
- **Breaking for 0.2.0 consumers of the domain** (pre-1.0, called out for the release notes):
  `PaymentMethod`, `ClientAction`, `OrderNotice` and `EmailTemplate` are wider, so an exhaustive
  `switch` or `Record` over any of them must add the new member. `TransitionOrderDeps` gains the
  optional `offlinePayment`, and an offline Mark paid without it throws. The plugin's
  `CheckoutRequestWire.paymentMethod`, `ClientActionWire` and `PaymentConfigRouteResult` are
  wider in the same way.
