# @urumi.ai/otta-admin-presentation

Otta admin presentation primitives — money rendering, the console date dialect, git-style short ids and the order-status vocabulary. Pure functions: no IO, no React, no EmDash. Shared by the Block Kit plugin and the React console so neither surface can drift from the other.

## Install

```sh
pnpm add @urumi.ai/otta-admin-presentation
```

ESM-only, no dependencies and no peer dependencies.

## Entry points

| Import | What it is |
|---|---|
| `@urumi.ai/otta-admin-presentation` | Everything: money formatting and input parsing, the currency table, dates, short ids, order numbers. |

## Usage

```ts
import { cents, currency, formatMoney } from "@urumi.ai/otta-admin-presentation";

formatMoney(cents(1999), currency("USD"), "en-US"); // "$19.99"
```

## More

Part of [Otta](https://github.com/UrumiAI/otta.sh#readme), an open-source commerce layer for EmDash.

MIT licensed.
