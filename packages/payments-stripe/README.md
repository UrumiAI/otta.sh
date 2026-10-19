# @otta-sh/payments-stripe

Stripe `PaymentGateway` adapter for Otta — async-webhook confirmation with raw-body HMAC verification. It implements the `PaymentGateway` port from `@otta-sh/domain`.

## Install

```sh
pnpm add @otta-sh/payments-stripe
```

ESM-only. It depends on `@otta-sh/domain`, which installs with it.

## Entry points

| Import | What it is |
|---|---|
| `@otta-sh/payments-stripe` | `StripePaymentGateway`, the `fetch`-backed `createStripeHttpTransport`, and `signStripeWebhook` for tests. |

## Usage

`webhookSecret` is required. `secretKey` is required to take real payments: creating, cancelling and refunding intents all call Stripe with it. Without it the gateway runs an offline, deterministic mode for tests, whose client secrets cannot be paid, and `refundable` is false:

```ts
import { StripePaymentGateway } from "@otta-sh/payments-stripe";

const gateway = new StripePaymentGateway({
	webhookSecret: "whsec_...",
	secretKey: "sk_...",
});
```

Inside Otta you do not construct this yourself: `@otta-sh/plugin` wires it from the keys saved on the admin Settings page, which are encrypted at rest only when the site's descriptor declares the plugin's `PAYMENT_SECRET_SETTINGS_SCHEMA` ([ADR-0037](https://github.com/UrumiAI/otta.sh/blob/main/adr/0037-payment-secrets-are-encrypted-at-rest.md)).

## More

Part of [Otta](https://github.com/UrumiAI/otta.sh#readme), an open-source commerce layer for EmDash.

MIT licensed.
