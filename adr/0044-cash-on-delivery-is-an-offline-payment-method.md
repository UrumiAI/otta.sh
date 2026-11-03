# 0044. Cash on delivery is an offline payment method

- Status: accepted
- Date: 2026-11-03
- Revised: 2026-11-03, after review round 1 and the product owner's decisions A–D. The first
  version held a COD order in `pending` with a hold deadline in the year 9999. That sentinel is
  gone, replaced by two order states. Everything below is the revised record.
- Decided by: the product owner, 2026-11-03. That covers a separate package, a Settings toggle,
  each method enabled independently, dedicated order states, auto-cancel, abuse controls and
  physical carts only. This record holds the engineering decisions made within those.
- Amends: [ADR-0026](./0026-admin-order-actions-never-claim-money-that-did-not-move.md). Its
  consequence that the admin "can no longer move an order to `paid` at all" no longer holds for
  an offline method. ADR-0026 carries a dated note.

## Context

Otta took one payment method, Stripe, so a store without a Stripe account could not complete
checkout. Many merchants who sell physical goods are paid in cash at the door. They need four
things:

- a checkout that places the order with no online payment;
- a way to ship before they are paid;
- a way to mark the order paid when the courier hands over the cash;
- Otta never claiming that money moved before it did.

ADR-0026 Decision 1 already refuses a manual `pending → paid` unless the order's method is
declared `"offline"`.

A pending order does not fit COD:

- it expires at its 15-minute hold, and the intent-cancel sweep withdraws its payment intent;
- `shipped` counts as revenue (`REVENUE_COUNTING_STATES`, the reports' allow-list), so a COD
  order shipped before payment cannot be `shipped`.

## Decision

### 1. `cod` is a payment method, declared offline

`PaymentMethod` becomes `"stripe" | "cod"`. `orders/payment-methods.ts` holds
`PAYMENT_METHOD_SETTLEMENT = { stripe: "gateway", cod: "offline" }`, the one table of current
methods. `settlementOf(stored)` reads it and fails closed: `null` and unknown methods have no
settlement. The public and admin order wires carry `settlement: "gateway" | "offline" | null`.
The site and the console branch on that field, never on `=== "cod"`.

### 2. Two new order states

| State | Meaning | Legal moves |
|---|---|---|
| `awaiting_payment` | placed, unpaid, not shipped. Stock is held for the order | `paid` (Mark paid), `shipped_awaiting_payment` (Record shipment), `cancelled` (Cancel order) |
| `shipped_awaiting_payment` | shipped before payment; the cash is due at the door | `delivered` (Mark paid: the courier collected the cash), `cancelled` (Cancel order: delivery refused, parcel returned) |

`pending` gains `pending → awaiting_payment`. Checkout places the order `pending`, adopts its
holds, flips the cart, asks the gateway, and then flips the order to `awaiting_payment`. A crash
before that last flip leaves an ordinary pending order, which the same-key replay finishes or the
expiry sweep expires. The three moves into and out of these states (`→ awaiting_payment`,
`→ shipped_awaiting_payment`, and the two Mark paid targets) require an offline method.
`transitionOrderAsAdmin` refuses them otherwise.

Neither new state is in `REVENUE_COUNTING_STATES`, and neither is "captured" for the "Paid"
label. A COD order counts as revenue when it enters `paid` or `delivered` through Mark paid.

Flows:

- **Ship first:** `awaiting_payment → shipped_awaiting_payment` (Record shipment, with tracking
  and the shipped email) `→ delivered` (Mark paid) `→ completed`.
- **Paid first** (collected in store, say): `awaiting_payment → paid` (Mark paid), then the
  ordinary `processing → shipped → delivered → completed`.

The expiry sweep lists only `pending`, so it never touches these states. The old sentinel
deadline (`OFFLINE_HOLD_EXPIRES_AT`) is removed. A COD order's `holdExpiresAt` is the ordinary
checkout deadline and means nothing once it leaves `pending`.

### 3. Stock

Placing the order adopts its holds, as for a card order. They stay adopted until one of three
things happens:

- Mark paid commits them, in the same way a settlement does.
- Cancel order (or auto-cancel) releases them through the store's release intent, the path every
  cancel already takes. A cancelled `shipped_awaiting_payment` order is a returned parcel, so
  its units go back on sale.
- Nothing else. No sweep reaps an adopted hold.

### 4. Mark paid is a recorded payment, safe to repeat

For an offline order, `transitionOrderAsAdmin` to `paid` (from `awaiting_payment`) or to
`delivered` (from `shipped_awaiting_payment`) records the payment. The order of operations is
chosen so that a crash leaves something the next click finishes:

1. **Before the flip**, idempotently: grant the order's downloads (keyed per order and sku), then
   record the `payments` row for the order total under `offline:<method>:<orderId>`. The row is
   idempotent on that reference. A crash here leaves the order in its unpaid state, the console
   still offers Mark paid, and the retry finishes the job.
2. **The flip**: `OrderStore.markPaid(orderId, providerRef, { fromState, toState, actor })`. It
   is guarded on `fromState`, enqueues the state's email, records the commit intent (in the
   document store) and records the **actor** on the audit event, so the console's History shows
   who marked it paid. `markPaid` gains these optional arguments in every adapter.
3. **After the flip**: commit the holds, as settlement does. The document store's commit intent
   heals a crash here.

If the flip loses, there are two cases:

- A concurrent Mark paid won: the result is the idempotent no-op.
- A concurrent Cancel won: the cash was attested, so the payment row stays. The order is flagged
  for reconciliation ("cash recorded on an order cancelled at the same moment") and any grants
  are revoked.

The console asks before it acts: "Confirm you received {total} in cash. This records the payment
and emails the buyer."

### 5. Refunds

The gateway is `refundable: false`, so a refund is a manual refund in Money → Refunds
(ADR-0008). Cancel order on a paid COD order refuses `REFUND_NOT_AUTOMATIC` until it has been
refunded, as ADR-0026 already does for any non-refundable gateway.

### 6. Auto-cancel (decision B)

A merchant setting, `settings:codAutoCancelDays`, defaults to **14**; 0 turns it off. The
`cod-auto-cancel` sweep leg lists `awaiting_payment` orders whose `createdAt` is older than that.
It uses the documents' `["state", "createdAt"]` index, oldest first, in bounded batches inside
the tick's query budget. For each order it:

- cancels through `cancelOrder`, with reason `other` and detail "Not paid within N days". This
  releases the stock and enqueues the cancelled email;
- releases the coupon use (`releaseByOrder`). Unlike a merchant cancel, nobody chose to keep the
  coupon.

An order whose ledger already shows a captured payment (a half-finished Mark paid) is skipped and
flagged, never cancelled. `shipped_awaiting_payment` orders are never auto-cancelled, because
the goods are out. The live setting applies to all open orders, so lowering it cancels older
orders on the next tick. The Settings copy says so.

### 7. Abuse controls (decision C)

1. **The per-IP write limit is a precondition.**
   - COD is offered and accepted only when the site has the `RATE_LIMIT_WRITES` binding
     (DEPLOYMENT.md §2.5). The plugin cannot see the site's bindings, so the site enforces it.
   - Without the binding, the site leaves COD out of the method list, and `/checkout/place`
     refuses `PAYMENT_METHOD_UNAVAILABLE`.
   - With it, the site sends the client's network key (`clientNetwork`: an IPv4 address or an
     IPv6 /64). The plugin refuses a COD placement that carries no key.
   - The Settings group states the requirement.
2. **Caps on open COD orders.**
   - "Open" means `awaiting_payment` or `shipped_awaiting_payment`.
   - There are two caps, each merchant-configurable and defaulting to **3**: per buyer email
     (`settings:codMaxOpenPerBuyer`) and per client network (`settings:codMaxOpenPerClient`).
     0 means no cap.
   - The domain checks both before minting anything, through
     `OrderStore.countOpenOfflineOrders`. The buyer count uses the indexed `buyerRefLower`.
   - The order stores a one-way hash of the network key (`offlineClientKey`, a new indexed
     field), never the address.
   - Over a cap, the order is refused `OFFLINE_ORDER_LIMIT`.
   - The caps are soft under a true race: two simultaneous placements may both pass. The per-IP
     write limit bounds that.

### 8. Physical carts only (decision D)

COD is refused for a cart with no physical line (`OFFLINE_NEEDS_PHYSICAL`) and hidden for one at
checkout. A COD order needs a full delivery address and a phone number, on every store,
including stores with no shipping zones:

- a missing address is `MISSING_SHIPPING_ADDRESS`;
- a missing phone is `SHIPPING_PHONE_REQUIRED`.

A Stripe account's India rule (#382) applies only to card payment. For COD, the address
requirement comes from the COD rule above.

### 9. The gateway, `@urumi.ai/otta-payments-cod`

| Verb | Answer |
|---|---|
| `createIntent` | `{ gateway: "cod", intentId: "", clientAction: { kind: "offline" } }`, deterministic |
| `verifyConfirmation` | always `UNKNOWN_EVENT`: nothing at a settle route can mark a COD order paid |
| `refundable` / `refund` | `false` / `UNSUPPORTED` |
| `cancelIntent` | `UNSUPPORTED` |

`offlinePaymentGatewayContract` holds it to that, and `offlinePaymentContract` holds every store
dialect to the lifecycle. The plugin's depcruise perimeter admits the package.

### 10. Emails

- **Entering `awaiting_payment`** sends the `order-placed-offline` state email: "Order received …
  you'll pay in cash when it's delivered", with the amount due.
- **Entering `shipped_awaiting_payment`** sends the shipped email with tracking, plus "Please
  have {total} ready".
- **Mark paid** sends the `paid` or `delivered` email. For an offline order, either says the cash
  payment was received.

This replaces the first version's `order-placed-offline` notice. `OrderNotice` is unchanged.

### 11. Checkout and the storefront

- `storefront/payment-config` adds `cashOnDelivery: { enabled, instructions }`. A kv failure
  reading the COD settings reads as COD off and never fails the route, so card-only stores are
  unaffected.
- `storefront/checkout/place` takes `paymentMethod` (absent means `"stripe"`; any other value is
  `INVALID_INPUT`, a deliberate refusal) and, for COD, `clientKey`.
- The toggle and the caps are checked inside `createOrderFromCart`, after the same-key replay
  short-circuit. A replay whose first reply was lost therefore returns the existing order even if
  COD was switched off since.
- `storefront/order/resume` refuses an offline order up front (`ORDER_NOT_PAYABLE`).
- `abandonCartOrder` never cancels an order that is not `pending`, so a placed COD order
  survives "start a new cart". The confirmation page forgets the spent cart's cookie, so the next
  add-to-cart starts a fresh cart.
- The site shows a method choice when more than one method is offered and COD applies to the
  cart. The button label follows the chosen method; this is CSS, with no script. "Continue to
  payment" appears only when card is chosen.
- The confirmation and account pages say "Order placed. You'll pay in cash when your order is
  delivered." Once paid, they say "Payment received".
- The step tracker sits at Order.
- The console labels the states, names the method, offers a "Cash on delivery — awaiting
  payment" filter, and confirms Mark paid.

### 12. Existing stores

Nothing changes until a merchant switches COD on:

- the toggle reads off;
- the payment-config answer gains a field;
- a place call with no method is a card place;
- no stored data is migrated.

## Consequences

- With only COD enabled, a store completes checkout, ships, gets paid and completes an order
  with no Stripe keys.
- Every money claim still rests on a payment recorded on the ledger, by a gateway or by a
  person's attestation. ADR-0026's guarantee holds.
- An unpaid COD order holds its stock for at most the auto-cancel window, or until it ships.
- **Breaking for 0.2.0 consumers** (pre-1.0; this list is for the release notes):
  - **Domain types.**
    - `OrderState` gains `awaiting_payment` and `shipped_awaiting_payment`. An exhaustive
      `switch` or `Record` over states must add them, and a reader of `state` must not assume
      every non-terminal order is `pending` or paid.
    - `PaymentMethod` gains `"cod"`, `ClientAction` gains `{ kind: "offline" }`, and
      `EmailTemplate` gains `"order-placed-offline"`.
    - `CreateOrderFailure` gains `OFFLINE_NEEDS_PHYSICAL`, `SHIPPING_PHONE_REQUIRED`,
      `OFFLINE_ORDER_LIMIT` and `PAYMENT_METHOD_UNAVAILABLE`.
    - `CreateOrderCommand` gains an optional `offline` block.
  - **Domain ports and use-cases.**
    - `OrderStore` gains `countOpenOfflineOrders` and `listAwaitingPaymentBefore`. `markPaid`
      gains an optional third argument `{ fromState, toState, actor }`, and
      `RecordFulfillmentInput` gains `toState`. Every adapter must implement these.
    - `TransitionOrderDeps` gains `offlinePayment`. An offline Mark paid without it throws.
    - `applyPaidSideEffects` is exported.
  - **Plugin wire.**
    - `CheckoutRequestWire.paymentMethod`, `ClientActionWire` and `PaymentConfigRouteResult`
      are wider.
    - The public and admin order wires gain `settlement`.
    - `CheckoutPlaceRouteResult` gains `PAYMENT_METHOD_UNAVAILABLE`, `OFFLINE_NEEDS_PHYSICAL`,
      `SHIPPING_PHONE_REQUIRED` and `OFFLINE_ORDER_LIMIT`.
    - `paymentMethod` parsing is strict: an unknown value is `INVALID_INPUT`, not card. A caller
      that sent junk was relying on nothing before, because the field did not exist.
  - **Storefront cost.** The storefront reads three or four more kv keys per checkout place and
    payment-config call: the COD toggle, its instructions and the caps.
- Follow-ups:
  - a report of old unpaid COD orders;
  - COD instructions in the emails;
  - a plugin-side proof of the site's rate-limit binding. Today the plugin trusts the site's
    `clientKey`, and its own public place route is rate-limited by the same binding.
