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

`webhookSecret` is required; `secretKey` is needed for refunds, and without it refunds are reported as unavailable:

```ts
import { StripePaymentGateway } from "@otta-sh/payments-stripe";

const gateway = new StripePaymentGateway({
	webhookSecret: "whsec_...",
	secretKey: "sk_...",
});
```

Inside Otta you do not construct this yourself: `@otta-sh/plugin` wires it from the keys saved in the admin Settings page.

## More

Part of [Otta](https://github.com/UrumiAI/otta.sh#readme), an open-source commerce layer for EmDash.

MIT licensed.
