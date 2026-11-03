# @urumi.ai/otta-payments-cod

Cash on delivery for [Otta](https://github.com/UrumiAI/otta.sh): a `PaymentGateway` adapter for an
**offline** payment method ([ADR-0042](../../adr/0042-cash-on-delivery-is-an-offline-payment-method.md)).

The buyer places the order at checkout and pays in cash when it arrives. There is no online
payment, no webhook and no secret to configure.

## Turning it on

In the EmDash admin, open **Otta → Store settings → General → Payments** and switch on
**Cash on delivery**. You can also add instructions for buyers, such as "Please have the exact
amount ready." The checkout shows them under the method. Stripe and cash on delivery are
independent: enable either or both. With only cash on delivery enabled, checkout works with no
Stripe keys at all. See [DEPLOYMENT.md](../../DEPLOYMENT.md).

The Otta plugin wires this package itself. A site does not import it.

## What the gateway does

| Verb | Answer |
|---|---|
| `id` | `"cod"`, declared `"offline"` in the domain's `PAYMENT_METHOD_SETTLEMENT` |
| `createIntent` | `{ intentId: "", clientAction: { kind: "offline" } }`. The order is placed, nothing is charged and no intent is recorded |
| `verifyConfirmation` | always rejects (`UNKNOWN_EVENT`), because no webhook can mark a COD order paid |
| `refundable` / `refund` | `false` / `UNSUPPORTED`. Cash goes back by hand and is recorded as a manual refund |
| `cancelIntent` | `UNSUPPORTED`, because there is no standing intent to withdraw |

## The order's life

1. **Placed.** The order is `pending`, and its stock is taken off sale for it. It **never
   expires**: the checkout hold timer does not apply. The buyer gets an "Order received, pay on
   delivery" email.
2. **Delivered and paid.** When the cash is in hand, the admin clicks **Mark paid** in Orders. This
   records the payment for the order total, commits the stock, grants any downloads and sends the
   "payment received" confirmation. After that the order moves like any other: processing,
   shipped, delivered, completed.
3. **Cancelled before payment.** **Cancel order** returns the stock.
4. **Refunds.** Once the order is paid, give the cash back yourself and record it in
   **Money → Refunds**. That records a manual refund, and recording the full amount closes the
   order as `refunded`.

## Tests

`test/cod-gateway.contract.test.ts` runs the domain's `offlinePaymentGatewayContract`. The
lifecycle (no expiry, Mark paid, cancel) is the domain's `offlinePaymentContract`, run against
every store dialect. `test/sandbox-clean-guard.test.ts` checks that `src` imports nothing but the
domain.
