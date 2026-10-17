# @otta-sh/domain

Otta commerce domain — pure ports, use-cases, and branded types. No IO: it imports no database driver, no host code and no `fetch`, so it runs anywhere and is the spec the store adapters are held to.

## Install

```sh
pnpm add @otta-sh/domain
```

ESM-only. `vitest` is an optional peer dependency, needed only if you use `@otta-sh/domain/testing`.

## Entry points

| Import | What it is |
|---|---|
| `@otta-sh/domain` | Ports, use-cases, and branded money types. |
| `@otta-sh/domain/subdivision-names` | Country subdivision lookups (`subdivisionOptions`, `subdivisionName`). |
| `@otta-sh/domain/testing` | In-memory stores, fakes, and the contract-test suites adapters are verified against. |

## Usage

Money is integer minor units, branded with a currency, so a bare `number` is a type error:

```ts
import { cents, currency } from "@otta-sh/domain";

const price = cents(1500); // 15.00 in a two-decimal currency
const usd = currency("USD");
```

## More

Part of [Otta](https://github.com/UrumiAI/otta.sh#readme), an open-source commerce layer for EmDash. Design decisions are in the repo's [`adr/`](https://github.com/UrumiAI/otta.sh/tree/main/adr).

MIT licensed.
