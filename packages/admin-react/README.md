# @urumi.ai/otta-admin-react

Otta React admin console — the `otta-console` native-format EmDash descriptor (ADR-0014). It adds the Orders page, the product editor's Pricing & stock cards (and the Download file card for a digital product), and the products list's Price / Stock columns. Zero capabilities, zero `allowedHosts`; it reaches commerce only through the existing authenticated `otta` admin routes, so it needs `@urumi.ai/otta-plugin` registered alongside it.

## Install

```sh
pnpm add @urumi.ai/otta-admin-react
```

ESM-only. Peer dependencies: `emdash` `^1.0.1` and `react` `^19.2.4`. Node `>=22.16`.

## Entry points

| Import | What it is |
|---|---|
| `@urumi.ai/otta-admin-react` | The plugin module EmDash calls: `createPlugin`, plus the `OTTA_CONSOLE_*` constants a descriptor needs. |
| `@urumi.ai/otta-admin-react/admin` | The admin module EmDash loads in the browser: the `pages`, `fields` and `contentListColumns` exports. |

## Usage

Register it in your EmDash config as a `native` plugin descriptor, next to the `otta` one. The reference site's [`otta-console-descriptor.ts`](https://github.com/UrumiAI/otta.sh/blob/main/sites/staging/src/otta-console-descriptor.ts) is the worked example. Its fields come straight from this package:

```ts
import {
	OTTA_CONSOLE_ADMIN_ENTRY,
	OTTA_CONSOLE_ENTRYPOINT,
	OTTA_CONSOLE_PLUGIN_ID,
	OTTA_CONSOLE_PLUGIN_VERSION,
} from "@urumi.ai/otta-admin-react";
import type { PluginDescriptor } from "emdash";

export const ottaConsole: PluginDescriptor = {
	id: OTTA_CONSOLE_PLUGIN_ID,
	version: OTTA_CONSOLE_PLUGIN_VERSION,
	format: "native",
	entrypoint: OTTA_CONSOLE_ENTRYPOINT,
	adminEntry: OTTA_CONSOLE_ADMIN_ENTRY,
	capabilities: [],
	allowedHosts: [],
};
```

## More

Part of [Otta](https://github.com/UrumiAI/otta.sh#readme), an open-source commerce layer for EmDash.

MIT licensed.
