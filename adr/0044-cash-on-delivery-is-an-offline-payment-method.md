# 0044. Cash on delivery is an offline payment method

- Status: accepted
- Date: 2026-11-03
- Revised: 2026-11-03, after review round 1 and the product owner's decisions A–D. The first
  version held a COD order in `pending` with a hold deadline in the year 9999. That sentinel is
  gone, replaced by two order states. Everything below is the revised record.
- Revised again: 2026-11-03, after review round 2.
  - The plugin derives the client network itself, and COD requires proof that the call came
    through the site's rate-limited path (§7).
  - The network key is an HMAC under a per-store secret.
  - The per-network cap defaults to 20.
  - Auto-cancel frees the coupon use before it cancels.
  - A Mark paid that loses to a Record shipment is retryable.
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

If the flip loses, there are three cases:

- A concurrent Mark paid won: the result is the idempotent no-op.
- A concurrent move left the order unpaid and still payable: a Record shipment (now
  `shipped_awaiting_payment`), or the placement's own flip from a same-key checkout replay
  (`pending` to `awaiting_payment`). Nothing is revoked or flagged. The result is
  `MARK_PAID_RETRY`, and the console asks the merchant to click Mark paid again, which lands the
  order from where it now is (`delivered`, or `paid`). The payment row already recorded is the same
  idempotent row.
- A concurrent Cancel won: the cash was attested, so the payment row stays. The order is flagged
  for reconciliation ("cash recorded on an order cancelled at the same moment") and any grants
  are revoked.

Only `transitionOrderAsAdmin` makes these moves. The bare `transitionOrder` refuses the offline
Mark paid targets with `INVALID_TRANSITION`, because it records no payment.

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

- **first** frees the coupon use (`releaseByOrder`, idempotent and order-scoped). Unlike a
  merchant cancel, nobody chose to keep the coupon. If the release fails, or the tick cannot
  afford it, the order is not cancelled this run: it stays listed and is retried on a later
  pass. The coupon-orphans leg judges a redemption only once, so the release can never be left to
  it. "Afford" counts the cancel after the release too, since the cancel runs outside the commit
  window: what the cancel still costs once the release returns (measured at 17 calls), not the
  whole order's unit, so a coupon order fits a Workers Free tick;
- then cancels through `cancelOrder`, with reason `other` and detail "Not paid within N days".
  This releases the stock and enqueues the cancelled email.

The cost of releasing first: in the moment between the release and the cancel, a concurrent Mark
paid can win. That order is then paid with its coupon use freed, which allows at most one extra
use of a capped coupon. The order's own discount is unaffected. We accept this rather than a use
that is never freed.

An order whose ledger already shows a captured payment (a half-finished Mark paid) is skipped and
flagged, never cancelled.

The walk keeps a `(createdAt, orderId)` cursor in the sweep's cadence state and moves past every
order it looks at, skipped ones included. Without it, a skipped order stays at the head of the
listing, and on a tick that affords one order (Workers Free) no younger order is ever reached.
When a run drains the listing the cursor is cleared, so the next pass starts at the oldest again
and the skipped orders are looked at once per pass. `shipped_awaiting_payment` orders are never auto-cancelled, because
the goods are out. The live setting applies to all open orders, so lowering it cancels older
orders on the next tick. The Settings copy says so.

### 7. Abuse controls (decision C)

1. **The per-IP write limit is a precondition, and the plugin checks the proof itself.**
   - COD is offered and accepted only when the site has the `RATE_LIMIT_WRITES` binding
     (DEPLOYMENT.md §2.5).
   - The plugin's place route is also reachable directly, at
     `/_emdash/api/plugins/otta/storefront/checkout/place`. It therefore never trusts the body.
   - **The proof** is the `x-otta-cod-attest` header.
     - The site adds it only on its own in-process dispatch from `/checkout/place`, and only when
       the binding exists.
     - The site middleware refuses (400) every incoming HTTP request that carries it, so no
       outside caller can present it.
     - A COD placement without it is refused `PAYMENT_METHOD_UNAVAILABLE`.
     - A site other than the reference one that hosts the plugin must strip or refuse the same
       header at its edge, or it does not offer COD safely.
   - **The network** is derived by the plugin from the request's `cf-connecting-ip` header:
     - an IPv4 address is used whole, and an IPv6 address is cut to its /64;
     - the site forwards that header on its synthetic request;
     - a direct call carries the one Cloudflare set;
     - no address means no COD.
     The public input no longer has a `clientKey`; a body field of that name is ignored.
   - The Settings group states the requirement.
2. **Caps on open COD orders.**
   - "Open" means `awaiting_payment` or `shipped_awaiting_payment`.
   - There are two caps, each merchant-configurable:
     - per buyer email (`settings:codMaxOpenPerBuyer`), default **3**;
     - per client network (`settings:codMaxOpenPerClient`), default **20**, because carrier and
       office NAT put many honest buyers behind one address, common in COD's main markets.
     0 means no cap.
   - A third cap is on one order's size: the physical units a single COD order may hold
     (`settings:codMaxUnitsPerOrder`), default **10**, 0 to 1000, 0 means no cap. The open-order
     caps count orders, and one cart line may hold up to `CART_LINE_MAX_QTY` (10,000) units, so
     without it one anonymous order could hold a SKU's whole stock for the auto-cancel window.
     It is checked first, from the cart's lines, and refused `OFFLINE_ORDER_LIMIT` like the others.
   - The domain checks both before minting anything, through
     `OrderStore.countOpenOfflineOrders`. The buyer count uses the indexed `buyerRefLower`.
   - The order stores `offlineClientKey`, a new indexed field: an HMAC-SHA-256 of the network
     under a per-store secret. The secret is random and kept in plugin kv
     (`settings:codNetworkKeySecret`), created on first use. A bare hash of an IPv4 address could
     be reversed by trying every address; the HMAC cannot without the secret.
     - The field is cleared when the order leaves the open states, so a paid, delivered or
       cancelled order keeps no network trace.
     - Two first uses racing could each create a secret, and the last write wins. Orders placed
       under the losing secret then under-count for their network until they close.
   - Over a cap, the order is refused `OFFLINE_ORDER_LIMIT`. The buyer copy is neutral: it does
     not say they have orders open.
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
- `storefront/checkout/place` takes `paymentMethod`. Absent means `"stripe"`; any other value
  is `INVALID_INPUT`, a deliberate refusal. COD also needs the attestation and the network
  (§7).
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

## Verified 2026-11-03: the new index on an upgraded install (review N6)

A store was booted from the pre-COD base (`eb0ffd45`, the merge-base with `main`) on a scratch
copy, and its e2e seed placed three orders. The same local D1 was then upgraded to this branch.

- The COD e2e placed, shipped, marked paid and completed an order on it. The three older orders
  were intact.
- EmDash materializes a configured plugin's declared indexes in
  `syncPluginStorageIndexesOnce()`, once per process, on the scheduler path. It uses an
  idempotent sync, `CREATE INDEX IF NOT EXISTS` plus `_plugin_indexes`.
- A short dev session fires no scheduled event, so the pre-COD store had no otta index at all.
  The old ones were missing too.
- After one scheduled tick (`/cdn-cgi/handler/scheduled`), `_plugin_indexes` listed
  `idx_plugin_otta_orders_offlineClientKey` and `idx_plugin_otta_orders_state_createdAt`, and
  SQLite held the index.

An upgraded install therefore gains the index on the first cron tick after deploy. Until then the
per-network count is correct, only unindexed.

## Round 3 additions

- **A cancel with only its own attestation (R3-3).** A Mark paid that lost to Record shipment
  leaves its attested payment row on a `shipped_awaiting_payment` order. Cancel order on an unpaid
  offline order whose only captured payment is that attestation now goes ahead and revokes any
  downloads it granted. The order is flagged ("cash recorded on a cash-on-delivery order that was
  then cancelled …") so a person settles the row. Any other captured payment is still
  `REFUND_NOT_AUTOMATIC`.
- **The auto-cancel's flip is guarded.** The auto-cancel cancels through the store's guarded flip
  from `awaiting_payment`. The generic `cancelOrder` re-reads the order and would have cancelled
  one that a concurrent Mark paid had just paid. If the guarded flip loses after the coupon use
  was freed, a warning names the order and the coupon. The use is not re-redeemed.
- **A deferred release is not an error.** A coupon release the caller deferred
  (`CouponReleaseDeferredError`, the tick's budget) is logged at info. A real failure stays at
  error.

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
  - the attestation as a per-store secret rather than a fixed marker (review R3-2). A host other
    than the reference site that does not strip the header would then fail closed instead of
    trusting it;
  - copy saying that 0 disables a control (the auto-cancel window, the caps).
