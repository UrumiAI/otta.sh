# @urumi.ai/otta-payments-cod

Cash on delivery for [Otta](https://github.com/UrumiAI/otta.sh): a `PaymentGateway` adapter for an
**offline** payment method ([ADR-0044](../../adr/0044-cash-on-delivery-is-an-offline-payment-method.md)).

The buyer places the order at checkout and pays in cash when it arrives. There is no online
payment, no webhook and no secret to configure.

## Turning it on

In the EmDash admin, open **Otta → Store settings → General → Cash on delivery** and switch on
**Offer cash on delivery at checkout**. You can also add instructions for buyers, such as "Please
have the exact amount ready." The checkout shows them under the method. Stripe and cash on
delivery are independent: enable either or both. With only cash on delivery enabled, checkout
works with no Stripe keys at all. See [DEPLOYMENT.md](../../DEPLOYMENT.md).

The Otta plugin wires this package itself. A site does not import it.

### Before you switch it on

- **The site needs its per-IP write limit.** Checkout offers cash on delivery only when the site
  has the `RATE_LIMIT_WRITES` binding (DEPLOYMENT.md §2.5). Without it, the site leaves cash on
  delivery out of checkout even when the setting is on.
  - A place call proves it came through the site's rate-limited path with the
    `x-otta-cod-attest` header. The site sets the header only on its own in-process dispatch, and
    its middleware refuses it from any outside request. A direct call to the plugin's place route
    is refused `PAYMENT_METHOD_UNAVAILABLE`.
  - The plugin derives the buyer's network from `cf-connecting-ip` and stores only an HMAC of it
    under a per-store secret, dropped once the order closes.
- **Physical goods only.** A cart with nothing to deliver cannot use cash on delivery
  (`OFFLINE_NEEDS_PHYSICAL`).
- **A delivery address with a phone number** is required on every store, even one with no
  shipping zones (`MISSING_SHIPPING_ADDRESS`, `SHIPPING_PHONE_REQUIRED`). The courier calls it.

### The other settings

| Setting | Default | Meaning |
|---|---|---|
| Auto-cancel unpaid orders after (days) | 14 | 0 to 365. An order still unpaid and not shipped after this many days is cancelled and its items go back on sale. 0 turns it off. The window applies to every open order, so lowering it cancels older unpaid orders on the next sweep |
| Most unpaid orders per buyer email | 3 | 0 to 100. A buyer with this many open cash-on-delivery orders cannot place another (`OFFLINE_ORDER_LIMIT`). 0 means no cap |
| Most unpaid orders per network | 20 | 0 to 100. The same cap, per client network (an IPv4 address or an IPv6 /64), set high because carrier and office NAT share one address. 0 means no cap |

"Open" means awaiting payment, or shipped and awaiting payment. The caps are soft under a true
race: two placements at the same instant may both pass. The per-IP write limit bounds that.

Switching cash on delivery off stops new cash-on-delivery orders. Orders already placed with it
are unchanged and can still be marked paid, and a checkout retry of an order placed while it was
on still returns that order.

## What the gateway does

| Verb | Answer |
|---|---|
| `id` | `"cod"`, declared `"offline"` in the domain's `PAYMENT_METHOD_SETTLEMENT` |
| `createIntent` | `{ intentId: "", clientAction: { kind: "offline" } }`. The order is placed, nothing is charged and no intent is recorded |
| `verifyConfirmation` | always rejects (`UNKNOWN_EVENT`), because no webhook can mark a COD order paid |
| `refundable` / `refund` | `false` / `UNSUPPORTED`. Cash goes back by hand and is recorded as a manual refund |
| `cancelIntent` | `UNSUPPORTED`, because there is no standing intent to withdraw |

## The order's life

Two order states belong to cash on delivery. Neither counts as revenue.

| State | Meaning |
|---|---|
| `awaiting_payment` | Placed, unpaid, not shipped. Its stock is held for it |
| `shipped_awaiting_payment` | Shipped before payment. The cash is due at the door |

1. **Placed.** Checkout places the order in `awaiting_payment` with no pay step. Its stock is
   taken off sale for it, and the checkout hold timer no longer applies. The buyer gets an
   "Order received, pay in cash on delivery" email with the amount due. "Start a new cart" never
   cancels it, and it cannot be paid online.
2. **Shipped before payment** (the usual flow). **Record shipment** in Orders, with the carrier
   and tracking, moves it to `shipped_awaiting_payment` and emails the buyer the tracking and
   "Please have {total} ready".
3. **Paid.** When the courier hands over the cash, click **Mark paid**. The console asks you to
   confirm you received the total in cash. Mark paid records the payment for the order total,
   commits the stock, grants any downloads and emails the buyer that the cash payment was
   received. From `shipped_awaiting_payment` the order becomes `delivered`, then `completed`.
   From `awaiting_payment` (collected in store, say) it becomes `paid`, then moves like any
   other order: processing, shipped, delivered, completed. Mark paid is safe to click twice.
4. **Cancelled before payment.** **Cancel order** returns the stock. Cancelling a
   `shipped_awaiting_payment` order is a refused delivery: the parcel came back, so its units go
   back on sale.
5. **Auto-cancelled.** An `awaiting_payment` order older than the auto-cancel window is cancelled
   by the commerce sweep with "Not paid within N days". Its stock and its coupon use are
   released and the buyer gets the cancelled email. A shipped order is never auto-cancelled.
6. **Refunds.** Once the order is paid, give the cash back yourself and record it in
   **Money → Refunds**. That records a manual refund, and recording the full amount closes the
   order as `refunded`.

In Orders, the **Cash on delivery — awaiting payment** filter lists the orders still owed.

## Tests

`test/cod-gateway.contract.test.ts` runs the domain's `offlinePaymentGatewayContract`. The
lifecycle (the two states, Mark paid, cancel, auto-cancel) is the domain's
`offlinePaymentContract`, run against every store dialect. `test/sandbox-clean-guard.test.ts`
checks that `src` imports nothing but the domain.
